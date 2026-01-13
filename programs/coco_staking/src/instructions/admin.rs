use anchor_lang::prelude::*;
use crate::accounts::GlobalConfig;
use crate::constants::{MAX_LEVELS};

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    // space calculation: discriminator(8) + admin(32) + level_prices(8*MAX_LEVELS) + coco_rewards(8*MAX_LEVELS) + referral_referrer_bps(2) + orphan_parent_bps(2) + slot_count(1) + treasury(32) + pending_orphan_pdas(32*MAX_LEVELS) + campaign_token_atas(32*MAX_LEVELS) + pending_orphan_bumps(MAX_LEVELS) + pending_orphan_totals(8*MAX_LEVELS) + bump(1)
    #[account(init, payer = payer, space = 8 + 32 + (8 * MAX_LEVELS) + (8 * MAX_LEVELS) + 2 + 2 + 1 + 32 + (32 * MAX_LEVELS) + (32 * MAX_LEVELS) + (1 * MAX_LEVELS) + (8 * MAX_LEVELS) + 1, seeds = [b"global-config"], bump)]
    pub global: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_global(
    ctx: Context<InitializeGlobal>,
    level_prices: [u64; MAX_LEVELS],
    coco_rewards: [u64; MAX_LEVELS],
    referral_referrer_bps: u16,
    orphan_parent_bps: u16,
    slot_count: u8,
) -> Result<()> {
    let global = &mut ctx.accounts.global;
    global.admin = *ctx.accounts.payer.to_account_info().key;
    global.level_prices = level_prices;
    global.coco_rewards = coco_rewards;
    global.referral_referrer_bps = referral_referrer_bps;
    global.orphan_parent_bps = orphan_parent_bps;
    global.slot_count = slot_count;
    global.treasury = *ctx.accounts.payer.to_account_info().key; // default treasury = admin
    // pending orphan PDAs and campaign ATAs to be set later by admin
    global.pending_orphan_pdas = [Pubkey::default(); MAX_LEVELS];
    global.pending_orphan_bumps = [0u8; MAX_LEVELS];
    // parameter validation: bps and slot_count bounds
    require!(referral_referrer_bps <= 10000, ErrorCode::InvalidLevel);
    require!(orphan_parent_bps <= 10000, ErrorCode::InvalidLevel);
    require!(slot_count > 0 && slot_count <= 10, ErrorCode::InvalidLevel);
    require!(orphan_assignment_delay_seconds <= 30u64 * 24u64 * 3600u64, ErrorCode::InvalidLevel);

    global.pending_orphan_totals = [0u64; MAX_LEVELS];
    // default 24 hours
    global.orphan_assignment_delay_seconds = 86400;
    // default anti-gaming params
    global.per_wallet_max_commits_per_minute = 5u8;
    global.per_wallet_daily_cap = 10_000_000_000u64; // 10 SOL default

    Ok(())
}

#[derive(Accounts)]
pub struct SetRateLimits<'info> {
    #[account(mut, has_one = admin)]
    pub global: Account<'info, GlobalConfig>,
    pub admin: Signer<'info>,
}

pub fn set_rate_limits(ctx: Context<SetRateLimits>, per_minute: u8, daily_cap: u64) -> Result<()> {
    let global = &mut ctx.accounts.global;
    // validation
    require!(per_minute > 0 && per_minute <= 60, ErrorCode::InvalidLevel);
    // practical daily cap upper bound (e.g., 1_000_000 SOL in lamports as safety)
    require!(daily_cap <= 1_000_000u64 * 1_000_000_000u64, ErrorCode::InvalidLevel);

    global.per_wallet_max_commits_per_minute = per_minute;
    global.per_wallet_daily_cap = daily_cap;
    Ok(())
}

    global.campaign_token_atas = [Pubkey::default(); MAX_LEVELS];
    global.bump = *ctx.bumps.get("global").unwrap();

    Ok(())
}

#[derive(Accounts)]
#[instruction(level: u8)]
pub struct InitPendingOrphan<'info> {
    #[account(mut, has_one = admin)]
    pub global: Account<'info, crate::accounts::GlobalConfig>,

    // Create the pending orphan PDA for given level
    #[account(
        init,
        payer = admin,
        space = 8,
        seeds = [b"pending-orphan", level.to_le_bytes().as_ref()],
        bump
    )]
    pub pending_orphan_pda: Account<'info, UncheckedAccount<'info>>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn init_pending_orphan(ctx: Context<InitPendingOrphan>, level: u8) -> Result<()> {
    let idx = (level - 1) as usize;
    let global = &mut ctx.accounts.global;
    global.pending_orphan_pdas[idx] = *ctx.accounts.pending_orphan_pda.to_account_info().key;
    global.pending_orphan_bumps[idx] = *ctx.bumps.get("pending_orphan_pda").unwrap();
    Ok(())
}

#[derive(Accounts)]
#[instruction(level: u8)]
pub struct SetCampaignAta<'info> {
    #[account(mut, has_one = admin)]
    pub global: Account<'info, crate::accounts::GlobalConfig>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

pub fn set_campaign_ata(ctx: Context<SetCampaignAta>, level: u8, campaign_ata: Pubkey) -> Result<()> {
    let idx = (level - 1) as usize;
    let global = &mut ctx.accounts.global;
    global.campaign_token_atas[idx] = campaign_ata;
    Ok(())
}

#[derive(Accounts)]
#[instruction(level: u8, capacity: u32)]
pub struct InitOrphanPool<'info> {
    #[account(mut, has_one = admin)]
    pub global: Account<'info, crate::accounts::GlobalConfig>,

    #[account(
        init,
        payer = admin,
        space = 8 + 1 + 4 + (32 * 100) + 4 + 1, // simple fixed capacity
        seeds = [b"orphan-pool", level.to_le_bytes().as_ref()],
        bump
    )]
    pub orphan_pool: Account<'info, crate::accounts::OrphanPool>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn init_orphan_pool(ctx: Context<InitOrphanPool>, level: u8, _capacity: u32) -> Result<()> {
    let pool = &mut ctx.accounts.orphan_pool;
    pool.level = level;
    pool.queue = Vec::new();
    pool.head = 0;
    pool.tail = 0;
    pool.bump = *ctx.bumps.get("orphan_pool").unwrap();
    Ok(())
}

// Create a user account PDA for an owner
#[derive(Accounts)]
pub struct CreateUser<'info> {
    #[account(init, payer = payer, space = 8 + 32 + 1 + (1 * MAX_LEVELS) + (1 * MAX_LEVELS) + (4 + 32 * 0) + (4 + 32 * 0) + 1, seeds = [b"user", owner.key().as_ref()], bump)]
    pub user_account: Account<'info, crate::accounts::UserAccount>,

    /// CHECK: owner pubkey for PDA derivation
    pub owner: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn create_user(ctx: Context<CreateUser>) -> Result<()> {
    let user = &mut ctx.accounts.user_account;
    user.owner = *ctx.accounts.owner.to_account_info().key;
    user.highest_level = 0;
    for i in 0..MAX_LEVELS { user.activated[i] = false; user.referral_slots_used[i] = 0; user.per_level_parent[i] = None; user.per_level_orphan_parent[i] = None; }
    user.bump = *ctx.bumps.get("user_account").unwrap();
    Ok(())
}

// Admin: assign an orphan from pending pool to a parent and transfer pending lamports
#[derive(Accounts)]
pub struct AssignOrphan<'info> {
    #[account(mut, has_one = admin)]
    pub global: Account<'info, GlobalConfig>,

    #[account(mut)]
    pub orphan_pool: Account<'info, crate::accounts::OrphanPool>,

    /// CHECK: pending orphan PDA (holds lamports)
    #[account(mut)]
    pub pending_orphan_pda: UncheckedAccount<'info>,

    /// CHECK: parent user account that will receive funds
    #[account(mut)]
    pub parent_user_account: UncheckedAccount<'info>,

    #[account(signer)]
    pub admin: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn assign_orphan(ctx: Context<AssignOrphan>, level: u8) -> Result<()> {
    let idx = (level - 1) as usize;

    // pop first orphan in FIFO
    let orphan_addr = if !ctx.accounts.orphan_pool.queue.is_empty() {
        ctx.accounts.orphan_pool.queue.remove(0)
    } else {
        return Err(ErrorCode::NotImplemented.into());
    };

    // calculate amount to pay (we don't track exact per-orphan amounts; for MVP assume fixed parent share from global.level_prices)
    let parent_share = (ctx.accounts.global.level_prices[idx] as u128 * ctx.accounts.global.orphan_parent_bps as u128 / 10_000u128) as u64;

    // verify pending orphan PDA matches global and has funds
    if ctx.accounts.pending_orphan_pda.key() != ctx.accounts.global.pending_orphan_pdas[idx] {
        return Err(crate::errors::ErrorCode::PendingOrphanMismatch.into());
    }
    if ctx.accounts.global.pending_orphan_totals[idx] < parent_share {
        return Err(crate::errors::ErrorCode::InsufficientPendingOrphanBalance.into());
    }

    // Transfer lamports from pending orphan pda to parent_user_account (PDA signs)
    let ix = solana_program::system_instruction::transfer(
        ctx.accounts.pending_orphan_pda.key,
        ctx.accounts.parent_user_account.key,
        parent_share,
    );

    let p_bump = ctx.accounts.global.pending_orphan_bumps[idx];
    let level_arr: [u8;1] = [level];
    let bump_arr: [u8;1] = [p_bump];
    let seed0: &[u8] = b"pending-orphan";
    let seed1: &[u8] = &level_arr;
    let seed2: &[u8] = &bump_arr;
    let signer_seeds: &[&[u8]] = &[seed0, seed1, seed2];
    let signer: &[&[&[u8]]] = &[signer_seeds];

    solana_program::program::invoke_signed(
        &ix,
        &[
            ctx.accounts.pending_orphan_pda.to_account_info().clone(),
            ctx.accounts.parent_user_account.to_account_info().clone(),
            ctx.accounts.system_program.to_account_info().clone(),
        ],
        signer,
    )?;

    // update totals
    ctx.accounts.global.pending_orphan_totals[idx] = ctx.accounts.global.pending_orphan_totals[idx].checked_sub(parent_share).unwrap();

    emit!(crate::events::OrphanAssigned { orphan: orphan_addr, parent: *ctx.accounts.parent_user_account.key, level, amount: parent_share });

    Ok(())
}
