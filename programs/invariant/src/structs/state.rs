use anchor_lang::prelude::*;

#[account(zero_copy)]
#[repr(packed)]
#[derive(PartialEq, Default, Debug)]
pub struct State {
    pub admin: Pubkey,
    pub nonce: u8,
    pub authority: Pubkey,
    pub bump: u8,
}

// use anchor_lang::prelude::*;

// #[account(zero_copy)]
// #[repr(packed)]
// #[derive(PartialEq, Default, Debug)]
// pub struct State {
//     pub admin: Pubkey,           // Owner authority
//     pub authority: Pubkey,       // PDA program authority
//     pub base_token_mint: Pubkey, // Always MOJO
//     pub fee_collector: Pubkey,   // Treasury destination
//     pub nonce: u8,
//     pub bump: u8,
//     pub is_paused: bool,     // Emergency circuit breaker
//     pub fee_tier_count: u16, // Tracks fee tier configs (optional extension)
// }
