use anchor_lang::prelude::*;

pub mod accounts;
pub mod constants;
pub mod errors;
pub mod events;
pub mod instructions;

declare_id!("Coco111111111111111111111111111111111111111"); // TODO: replace with real program id

#[program]
pub mod coco_staking {
    use super::*;

    pub fn initialize_global(
        ctx: Context<instructions::admin::InitializeGlobal>,
        level_prices: [u64; MAX_LEVELS],
        coco_rewards: [u64; MAX_LEVELS],
        referral_referrer_bps: u16,
        orphan_parent_bps: u16,
        slot_count: u8,
    ) -> Result<()> {
        instructions::admin::initialize_global(ctx, level_prices, coco_rewards, referral_referrer_bps, orphan_parent_bps, slot_count)
    }

    pub fn create_user(ctx: Context<instructions::admin::CreateUser>) -> Result<()> {
        instructions::admin::create_user(ctx)
    }

    pub fn assign_orphan(ctx: Context<instructions::admin::AssignOrphan>, level: u8) -> Result<()> {
        instructions::admin::assign_orphan(ctx, level)
    }

    pub fn commit_level(
        ctx: Context<instructions::commit::CommitLevel>,
        level: u8,
        referrer: Option<Pubkey>,
        immediate_orphan_assign: bool,
    ) -> Result<()> {
        instructions::commit::commit_level(ctx, level, referrer, immediate_orphan_assign)
    }
}
