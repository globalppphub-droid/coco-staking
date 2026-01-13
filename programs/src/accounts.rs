use anchor_lang::prelude::*;
use crate::constants::MAX_LEVELS;

#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub level_prices: [u64; MAX_LEVELS],
    pub coco_rewards: [u64; MAX_LEVELS],
    pub referral_referrer_bps: u16,
    pub orphan_parent_bps: u16,
    pub slot_count: u8,
    pub treasury: Pubkey,
    pub pending_orphan_pdas: [Pubkey; MAX_LEVELS],
    pub campaign_token_atas: [Pubkey; MAX_LEVELS],
    pub pending_orphan_bumps: [u8; MAX_LEVELS],
    pub pending_orphan_totals: [u64; MAX_LEVELS],
    // anti-gaming: rate-limits and daily caps
    pub per_wallet_max_commits_per_minute: u8,
    pub per_wallet_daily_cap: u64,
    pub orphan_assignment_delay_seconds: u64,
    pub bump: u8,
}

#[account]
pub struct UserAccount {
    pub owner: Pubkey,
    pub highest_level: u8,
    pub activated: [bool; MAX_LEVELS],
    pub referral_slots_used: [u8; MAX_LEVELS],
    // timestamp (unix) when the level was activated (0 if not yet active)
    pub activation_timestamps: [i64; MAX_LEVELS],
    // user-level opt-in for immediate orphan assignment (can be enabled by user)
    pub immediate_assign: [bool; MAX_LEVELS],

    // anti-gaming per-user state
    pub last_commit_window_ts: i64, // minute-window timestamp
    pub commits_in_window: u8,
    pub daily_committed_total: u64,
    pub last_daily_reset_ts: i64,
    pub per_level_parent: [Option<Pubkey>; MAX_LEVELS],
    pub per_level_orphan_parent: [Option<Pubkey>; MAX_LEVELS],
    pub bump: u8,
}

#[account]
pub struct OrphanPool {
    pub level: u8,
    pub queue: Vec<Pubkey>, // bounded at init
    pub head: u32,
    pub tail: u32,
    pub bump: u8,
}
