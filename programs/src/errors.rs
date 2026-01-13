use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Not implemented yet")]
    NotImplemented,

    #[msg("Invalid level specified")]
    InvalidLevel,

    #[msg("Level already activated")]
    AlreadyActivated,

    #[msg("Insufficient funds for commit")]
    InsufficientFunds,

    #[msg("Pending orphan PDA mismatch for level")]
    PendingOrphanMismatch,

    #[msg("Insufficient pending orphan balance")]
    InsufficientPendingOrphanBalance,

    #[msg("Self-referral is not allowed")]
    SelfReferral,

    #[msg("No available slot on referrer")]
    NoAvailableSlot,
}
