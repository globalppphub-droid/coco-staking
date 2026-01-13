use anchor_lang::prelude::*;

#[event]
pub struct CommitEvent {
    pub user: Pubkey,
    pub level: u8,
    pub lamports: u64,
    pub referrer: Option<Pubkey>,
}

#[event]
pub struct SplitEvent {
    pub home: u64,
    pub referrer: Option<u64>,
    pub orphan_pool: Option<u64>,
}

#[event]
pub struct SlotActivated {
    pub referrer: Pubkey,
    pub level: u8,
    pub slots_used: u8,
}

#[event]
pub struct OrphanAssigned {
    pub orphan: Pubkey,
    pub parent: Pubkey,
    pub level: u8,
    pub amount: u64,
}

#[event]
pub struct GlobalConfigUpdated {
    pub field: String,
    pub old: u64,
    pub new: u64,
}
