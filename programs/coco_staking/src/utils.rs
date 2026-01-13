use anchor_lang::prelude::*;

/// Calculate share using basis points with safe u128 math (floor division)
pub fn calc_share(amount: u64, bps: u16) -> u64 {
    ((amount as u128 * bps as u128) / 10_000u128) as u64
}
