import { Market, Network } from '@invariant-labs/sdk/src'
import { Provider } from '@project-serum/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'
import * as bip39 from 'bip39'
import { derivePath } from 'ed25519-hd-key'

const RECEIVER_PUBKEY = new PublicKey(0)
const MNEMONIC = ''
const POSITION_INDEX = 0

const provider = Provider.local(
  'https://mainnet.helius-rpc.com/?api-key=ef843b40-9876-4a02-a181-a1e6d3e61b4c',
  {
    skipPreflight: true
  }
)

const connection = provider.connection

const main = async () => {
  const market = await Market.build(Network.MAIN, provider.wallet, connection)
  const seed = await bip39.mnemonicToSeed(MNEMONIC)
  const derivationPath = "m/44'/501'/0'/0'"
  const derivedSeed = derivePath(derivationPath, seed.toString('hex')).key
  const keypair = Keypair.fromSeed(derivedSeed)
  console.log(
    `Transfering position from ${keypair.publicKey.toString()} to ${RECEIVER_PUBKEY.toString()}`
  )
  const position = await market.getPosition(keypair.publicKey, POSITION_INDEX)
  console.log('Position to be transfered:\n', position)
  try {
    const tx = await market.transferPositionOwnershipTransaction({
      owner: keypair.publicKey,
      recipient: RECEIVER_PUBKEY,
      index: POSITION_INDEX
    })

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()

    tx.feePayer = keypair.publicKey
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight
    tx.sign(keypair)

    const serializedTx = tx.serialize()
    const signature = await connection.sendRawTransaction(serializedTx, {
      skipPreflight: false
    })

    const confirmedTx = await connection.confirmTransaction({
      blockhash: blockhash,
      lastValidBlockHeight: lastValidBlockHeight,
      signature: signature
    })

    if (confirmedTx.value.err === null) {
      console.log('Success')
    } else {
      console.log('Error sending transaction: ', confirmedTx.value.err)
    }
  } catch (e) {
    console.log('Error: ', e)
  }
}
main()
