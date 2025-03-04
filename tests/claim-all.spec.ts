import * as anchor from '@project-serum/anchor'
import { Provider, BN } from '@project-serum/anchor'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  Network,
  Market,
  Pair,
  LIQUIDITY_DENOMINATOR,
  PRICE_DENOMINATOR,
  sleep
} from '@invariant-labs/sdk'
import { createAssociatedTokenAccount, createToken, initMarket } from './testUtils'
import { assert } from 'chai'
import {
  createNativeAtaWithTransferInstructions,
  fromFee,
  signAndSend,
  tou64
} from '@invariant-labs/sdk/lib/utils'
import { ClaimAllFee, CreatePool, FeeTier, InitPosition } from '@invariant-labs/sdk/lib/market'
import { toDecimal } from '@invariant-labs/sdk/src/utils'
import { Swap } from '@invariant-labs/sdk/src/market'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  Token,
  TOKEN_PROGRAM_ID
} from '@solana/spl-token'
import { getLiquidity } from '@invariant-labs/sdk/lib/math'
import { ASSOCIATED_PROGRAM_ID } from '@project-serum/anchor/dist/cjs/utils/token'

describe('claim all fees', () => {
  const provider = Provider.local()
  const connection = provider.connection
  // @ts-expect-error
  const wallet = provider.wallet.payer as Keypair
  const admin = Keypair.generate()
  describe('Claim all fees on SPL tokens', () => {
    const mintAuthority = Keypair.generate()
    const positionOwner = Keypair.generate()
    const feeTier: FeeTier = {
      fee: fromFee(new BN(600)), // 0.6%
      tickSpacing: 10
    }
    let market: Market
    let pair: Pair
    let tokenX: Token
    let tokenY: Token

    before(async () => {
      market = await Market.build(
        Network.LOCAL,
        provider.wallet,
        connection,
        anchor.workspace.Invariant.programId
      )

      await Promise.all([
        connection.requestAirdrop(mintAuthority.publicKey, 1e9),
        connection.requestAirdrop(admin.publicKey, 1e9),
        connection.requestAirdrop(positionOwner.publicKey, 1e9)
      ])

      const tokens = await Promise.all([
        createToken(connection, wallet, mintAuthority),
        createToken(connection, wallet, mintAuthority)
      ])

      pair = new Pair(tokens[0].publicKey, tokens[1].publicKey, feeTier)
      tokenX = new Token(connection, pair.tokenX, TOKEN_PROGRAM_ID, wallet)
      tokenY = new Token(connection, pair.tokenY, TOKEN_PROGRAM_ID, wallet)
    })

    it('#init()', async () => {
      await initMarket(market, [pair], admin)
    })

    it('#claim', async () => {
      const upperTick = 10
      const lowerTick = -20

      const userTokenXAccount = await createAssociatedTokenAccount(
        connection,
        tokenX,
        positionOwner
      )
      const userTokenYAccount = await createAssociatedTokenAccount(
        connection,
        tokenY,
        positionOwner
      )

      const mintAmount = tou64(new BN(10).pow(new BN(10)))

      await tokenX.mintTo(userTokenXAccount, mintAuthority.publicKey, [mintAuthority], mintAmount)
      await tokenY.mintTo(userTokenYAccount, mintAuthority.publicKey, [mintAuthority], mintAmount)

      const liquidityDelta = { v: new BN(1000000).mul(LIQUIDITY_DENOMINATOR) }

      await market.createPositionList(positionOwner.publicKey, positionOwner)

      const initPositionVars: InitPosition = {
        pair,
        owner: positionOwner.publicKey,
        userTokenX: userTokenXAccount,
        userTokenY: userTokenYAccount,
        lowerTick,
        upperTick,
        liquidityDelta,
        knownPrice: { v: PRICE_DENOMINATOR },
        slippage: { v: new BN(0) }
      }
      await market.initPosition(initPositionVars, positionOwner)

      assert.ok((await market.getPool(pair)).liquidity.v.eq(liquidityDelta.v))

      const swapper = Keypair.generate()
      await connection.requestAirdrop(swapper.publicKey, 1e9)
      await sleep(1000)
      const amount = new BN(1000)
      const accountX = await tokenX.createAccount(swapper.publicKey)
      const accountY = await tokenY.createAccount(swapper.publicKey)

      await tokenX.mintTo(accountX, mintAuthority.publicKey, [mintAuthority], tou64(amount))

      const poolDataBefore = await market.getPool(pair)
      const reservesBeforeSwap = await market.getReserveBalances(pair, tokenX, tokenY)

      const swapVars: Swap = {
        pair,
        owner: swapper.publicKey,
        xToY: true,
        amount,
        estimatedPriceAfterSwap: poolDataBefore.sqrtPrice, // ignore price impact using high slippage tolerance
        slippage: toDecimal(1, 2),
        accountX,
        accountY,
        byAmountIn: true
      }
      await market.swap(swapVars, swapper)

      await sleep(1000)

      const poolDataAfter = await market.getPool(pair)
      assert.ok(poolDataAfter.liquidity.v.eq(poolDataBefore.liquidity.v))
      assert.ok(poolDataAfter.currentTickIndex === lowerTick)
      assert.ok(poolDataAfter.sqrtPrice.v.lt(poolDataBefore.sqrtPrice.v))

      const amountX = (await tokenX.getAccountInfo(accountX)).amount
      const amountY = (await tokenY.getAccountInfo(accountY)).amount
      const reservesAfterSwap = await market.getReserveBalances(pair, tokenX, tokenY)
      const reserveXDelta = reservesAfterSwap.x.sub(reservesBeforeSwap.x)
      const reserveYDelta = reservesBeforeSwap.y.sub(reservesAfterSwap.y)

      // fee tokens           0.006 * 1000 = 6
      // protocol fee tokens  ceil(6 * 0.01) = cei(0.06) = 1
      // pool fee tokens      6 - 1 = 5
      // fee growth global    5/1000000 = 5 * 10^-6
      assert.ok(amountX.eqn(0))
      assert.ok(amountY.eq(amount.subn(7)))
      assert.ok(reserveXDelta.eq(amount))
      assert.ok(reserveYDelta.eq(amount.subn(7)))
      assert.ok(poolDataAfter.feeGrowthGlobalX.v.eq(new BN('5000000000000000000')))
      assert.ok(poolDataAfter.feeGrowthGlobalY.v.eqn(0))
      assert.ok(poolDataAfter.feeProtocolTokenX.eqn(1))
      assert.ok(poolDataAfter.feeProtocolTokenY.eqn(0))

      const reservesBeforeClaim = await market.getReserveBalances(pair, tokenX, tokenY)
      const userTokenXAccountBeforeClaim = (await tokenX.getAccountInfo(userTokenXAccount)).amount

      const params: ClaimAllFee = {
        positions: [{ pair, index: 0, lowerTickIndex: lowerTick, upperTickIndex: upperTick }],
        owner: positionOwner.publicKey
      }

      await market.claimAllFees(params, positionOwner)
      await sleep(1000)

      const userTokenXAccountAfterClaim = (await tokenX.getAccountInfo(userTokenXAccount)).amount
      const positionAfterClaim = await market.getPosition(positionOwner.publicKey, 0)
      const reservesAfterClaim = await market.getReserveBalances(pair, tokenX, tokenY)
      const expectedTokensClaimed = 5

      assert.ok(reservesBeforeClaim.x.subn(expectedTokensClaimed).eq(reservesAfterClaim.x))
      assert.ok(positionAfterClaim.tokensOwedX.v.eqn(0))
      assert.ok(positionAfterClaim.feeGrowthInsideX.v.eq(poolDataAfter.feeGrowthGlobalX.v))
      assert.ok(
        userTokenXAccountAfterClaim.sub(userTokenXAccountBeforeClaim).eqn(expectedTokensClaimed)
      )
    })
    it('find tx size limit for spl tokens', async () => {
      const upperTick = 10
      const lowerTick = -20
      // There one additional position from previous test case
      const positionsToOpen = 3
      const pairs: Pair[] = []
      for (let i = 0; i < positionsToOpen; i++) {
        const tokens = await Promise.all([
          createToken(connection, wallet, mintAuthority),
          createToken(connection, wallet, mintAuthority)
        ])

        const pair = new Pair(tokens[0].publicKey, tokens[1].publicKey, feeTier)
        const [tokenX, tokenY] = tokens[0].publicKey.equals(pair.tokenX)
          ? [tokens[0], tokens[1]]
          : [tokens[1], tokens[0]]
        pairs.push(pair)

        const createPoolVars: CreatePool = {
          pair,
          payer: admin
        }
        await market.createPool(createPoolVars)

        const userTokenXAccount = await createAssociatedTokenAccount(
          connection,
          tokenX,
          positionOwner
        )
        const userTokenYAccount = await createAssociatedTokenAccount(
          connection,
          tokenY,
          positionOwner
        )
        const mintAmount = tou64(new BN(10).pow(new BN(10)))

        await tokenX.mintTo(userTokenXAccount, mintAuthority.publicKey, [mintAuthority], mintAmount)
        await tokenY.mintTo(userTokenYAccount, mintAuthority.publicKey, [mintAuthority], mintAmount)

        const liquidityDelta = { v: new BN(1000000).mul(LIQUIDITY_DENOMINATOR) }

        const initPositionVars: InitPosition = {
          pair,
          owner: positionOwner.publicKey,
          userTokenX: userTokenXAccount,
          userTokenY: userTokenYAccount,
          lowerTick,
          upperTick,
          liquidityDelta,
          knownPrice: { v: PRICE_DENOMINATOR },
          slippage: { v: new BN(0) }
        }
        await market.initPosition(initPositionVars, positionOwner)

        const swapper = Keypair.generate()
        await connection.requestAirdrop(swapper.publicKey, 1e9)
        await sleep(1000)
        const amount = new BN(1000)
        const accountX = await createAssociatedTokenAccount(connection, tokenX, swapper)
        const accountY = await createAssociatedTokenAccount(connection, tokenY, swapper)

        await tokenX.mintTo(accountX, mintAuthority.publicKey, [mintAuthority], tou64(amount))

        const poolDataBefore = await market.getPool(pair)
        const reservesBeforeSwap = await market.getReserveBalances(pair, tokenX, tokenY)

        const swapVars: Swap = {
          pair,
          owner: swapper.publicKey,
          xToY: true,
          amount,
          estimatedPriceAfterSwap: poolDataBefore.sqrtPrice, // ignore price impact using high slippage tolerance
          slippage: toDecimal(1, 2),
          accountX,
          accountY,
          byAmountIn: true
        }
        await market.swap(swapVars, swapper)

        await sleep(1000)
      }

      const params: ClaimAllFee = {
        positions: [{ pair, index: 0, lowerTickIndex: lowerTick, upperTickIndex: upperTick }],
        owner: positionOwner.publicKey
      }

      for (const pair of pairs) {
        params.positions.push({
          pair,
          index: 0,
          lowerTickIndex: lowerTick,
          upperTickIndex: upperTick
        })
      }

      await market.claimAllFees(params, positionOwner)
      await sleep(1000)
    })
  })
  describe('Claim all fees on pair with native on limit', () => {
    const mintAuthority = Keypair.generate()
    const positionOwner = Keypair.generate()
    let token: Token

    const feeTier: FeeTier = {
      fee: fromFee(new BN(600)), // 0.6%
      tickSpacing: 10
    }
    let market: Market
    let pair: Pair

    before(async () => {
      market = await Market.build(
        Network.LOCAL,
        provider.wallet,
        connection,
        anchor.workspace.Invariant.programId
      )

      await Promise.all([
        connection.requestAirdrop(mintAuthority.publicKey, 1e9),
        connection.requestAirdrop(admin.publicKey, 1e9),
        connection.requestAirdrop(positionOwner.publicKey, 1e9)
      ])

      const tokens = await Promise.all([createToken(connection, wallet, mintAuthority)])

      pair = new Pair(tokens[0].publicKey, NATIVE_MINT, feeTier)
      token = tokens[0]
    })

    it('#init()', async () => {
      await initMarket(market, [pair], admin)
    })

    it('#claim', async () => {
      const upperTick = 10
      const lowerTick = -20
      const positionsToOpen = 3
      const pairs: Pair[] = []
      for (let i = 0; i < positionsToOpen; i++) {
        const tokens = await Promise.all([createToken(connection, wallet, mintAuthority)])

        const pair = new Pair(tokens[0].publicKey, NATIVE_MINT, feeTier)

        pairs.push(pair)

        const createPoolVars: CreatePool = {
          pair,
          payer: admin
        }
        await market.createPool(createPoolVars)

        // let token: PublicKey
        // if (pair.tokenX === NATIVE_MINT) {
        //   token = tokens[0]
        // } else {
        //   token = pair.tokenX
        // }
        const token = tokens[0]

        const userTokenAccount = await createAssociatedTokenAccount(
          connection,
          token,
          positionOwner
        )

        const wrappedEthAccount = Keypair.generate()

        // create position list if it doesn't exist yet
        try {
          await market.getPositionList(positionOwner.publicKey)
        } catch (e) {
          await market.createPositionList(positionOwner.publicKey, positionOwner)
        }

        // liquidity can be calculated using the getLiquidity function
        // it will return an amount of liquidity that can be payed for with both tokens
        const tokenXAmount = new BN(20000000)
        const tokenYAmount = new BN(20000000)

        const pool = await market.getPool(pair)
        const {
          x,
          y,
          liquidity: liquidityDelta
        } = getLiquidity(
          tokenXAmount,
          tokenYAmount,
          lowerTick,
          upperTick,
          pool.sqrtPrice,
          true,
          pool.tickSpacing
        )

        let wethAmount: BN
        if (pair.tokenX === NATIVE_MINT) {
          wethAmount = x
          await token.mintTo(userTokenAccount, mintAuthority.publicKey, [mintAuthority], tou64(y))
        } else {
          wethAmount = y
          await token.mintTo(userTokenAccount, mintAuthority.publicKey, [mintAuthority], tou64(x))
        }

        const { createIx, initIx, transferIx, unwrapIx } = createNativeAtaWithTransferInstructions(
          wrappedEthAccount.publicKey,
          positionOwner.publicKey,
          Network.LOCAL,
          wethAmount
        )

        // we're creating a position an pool in the same time so slippage can be 0
        const slippage = toDecimal(0, 0)

        let initPositionVars: InitPosition

        if (pair.tokenX === NATIVE_MINT) {
          initPositionVars = {
            pair: pair,
            owner: positionOwner.publicKey,
            userTokenX: wrappedEthAccount.publicKey,
            userTokenY: userTokenAccount,
            lowerTick,
            upperTick,
            liquidityDelta,
            knownPrice: pool.sqrtPrice,
            slippage: slippage
          }
        } else {
          initPositionVars = {
            pair: pair,
            owner: positionOwner.publicKey,
            userTokenX: userTokenAccount,
            userTokenY: wrappedEthAccount.publicKey,
            lowerTick,
            upperTick,
            liquidityDelta,
            knownPrice: pool.sqrtPrice,
            slippage: slippage
          }
        }

        const initPositionIx = await market.initPositionTx(initPositionVars)
        const tx = new Transaction()
          // first 3 ixs create a weth account
          // last one returns the funds to the wallet
          .add(createIx)
          .add(transferIx)
          .add(initIx)
          .add(initPositionIx)
          .add(unwrapIx)

        await signAndSend(tx, [positionOwner, wrappedEthAccount], connection)
      }

      const params: ClaimAllFee = {
        positions: [],
        owner: positionOwner.publicKey
      }

      for (const pair of pairs) {
        params.positions.push({
          pair,
          index: 0,
          lowerTickIndex: lowerTick,
          upperTickIndex: upperTick
        })
      }

      await market.claimAllFees(params, positionOwner)
      await sleep(1000)
    })
  })
})
