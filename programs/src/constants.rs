use anchor_lang::prelude::*;

pub const MAX_LEVELS: usize = 5;

// Basis points (out of 10000)
pub const DEFAULT_REFERRER_BPS: u16 = 4000; // 40%
pub const DEFAULT_ORPHAN_PARENT_BPS: u16 = 2000; // 20%

pub const DEFAULT_SLOT_COUNT: u8 = 5;

// Level prices in lamports (SOL * 1_000_000_000)
pub const DEFAULT_LEVEL_PRICES: [u64; MAX_LEVELS] = [
    60_000_000,  // 0.06 SOL
    120_000_000, // 0.12
    240_000_000, // 0.24
    480_000_000, // 0.48
    960_000_000, // 0.96
];

// Placeholder COCO rewards (expressed as token units; treat as configable)
// For a simple placeholder, we mirror the SOL values (in lamports) for now.
pub const DEFAULT_COCO_REWARDS: [u64; MAX_LEVELS] = [
    60_000_000,  // placeholder for level 1 reward (0.06 SOL equivalent)
    120_000_000,
    240_000_000,
    480_000_000,
    960_000_000,
];
