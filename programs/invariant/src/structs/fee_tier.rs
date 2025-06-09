use crate::decimals::FixedPoint;
use anchor_lang::prelude::*;

#[account(zero_copy)]
#[repr(packed)]
#[derive(PartialEq, Default, Debug)]
pub struct FeeTier {
    pub fee: FixedPoint,   // e.g., 3000 = 0.3%
    pub tick_spacing: u16, // required for range AMMs
    pub bump: u8,
}
