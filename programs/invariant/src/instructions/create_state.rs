// use crate::structs::state::State;
// use anchor_lang::prelude::*;
// use anchor_lang::solana_program::system_program;

// #[derive(Accounts)]
// #[instruction( nonce: u8)]
// pub struct CreateState<'info> {
//     #[account(init, seeds = [b"statev1".as_ref()], bump, payer = admin)]
//     pub state: AccountLoader<'info, State>,
//     #[account(mut)]
//     pub admin: Signer<'info>,
//     #[account(seeds = [b"Invariant".as_ref()], bump = nonce)]
//     pub program_authority: AccountInfo<'info>,
//     pub rent: Sysvar<'info, Rent>,
//     #[account(address = system_program::ID)]
//     pub system_program: AccountInfo<'info>,
// }

// pub fn handler(ctx: Context<CreateState>, nonce: u8) -> ProgramResult {
//     msg!("INVARIANT: CREATE STATE");

//     let state = &mut ctx.accounts.state.load_init()?;
//     **state = State {
//         admin: *ctx.accounts.admin.key,
//         authority: *ctx.accounts.program_authority.key,
//         nonce,
//         bump: *ctx.bumps.get("state").unwrap(),
//     };
//     Ok(())
// }

use crate::structs::state::State;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_program;

#[derive(Accounts)]
#[instruction(nonce: u8)]
pub struct CreateState<'info> {
    #[account(init, seeds = [b"statev1".as_ref()], bump, payer = admin, space = 8 + std::mem::size_of::<State>())]
    pub state: AccountLoader<'info, State>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub base_token_mint: AccountInfo<'info>,
    pub fee_collector: AccountInfo<'info>,

    #[account(seeds = [b"Invariant".as_ref()], bump = nonce)]
    pub program_authority: AccountInfo<'info>,

    pub rent: Sysvar<'info, Rent>,

    #[account(address = system_program::ID)]
    pub system_program: AccountInfo<'info>,
}

pub fn handler(ctx: Context<CreateState>, nonce: u8) -> ProgramResult {
    msg!("MOJO: INITIALIZING GLOBAL STATE");

    let state = &mut ctx.accounts.state.load_init()?;

    **state = State {
        admin: *ctx.accounts.admin.key,
        authority: *ctx.accounts.program_authority.key,
        base_token_mint: *ctx.accounts.base_token_mint.key,
        fee_collector: *ctx.accounts.fee_collector.key,
        nonce,
        bump: *ctx.bumps.get("state").unwrap(),
        is_paused: false,
        fee_tier_count: 0,
    };

    Ok(())
}
