use crate::accounts::{GlobalConfig, OrphanPool, UserAccount};
use crate::constants::MAX_LEVELS;
use crate::errors::ErrorCode;
use crate::events::{CommitEvent, OrphanAssigned, SlotActivated, SplitEvent};
use crate::utils::calc_share;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use solana_program::program::invoke_signed;

#[derive(Accounts)]
pub struct CommitLevel<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [b"global-config"], bump = global.bump)]
    pub global: Account<'info, GlobalConfig>,

    #[account(mut, seeds = [b"user", payer.key().as_ref()], bump = user_account.bump)]
    pub user_account: Account<'info, UserAccount>,

    /// CHECK: owner of the user_account (destination for orphan-parent payouts)
    #[account(mut)]
    pub user_owner: UncheckedAccount<'info>,

    /// CHECK: optional referrer user account (PDA)
    #[account(mut)]
    pub referrer_user_account: UncheckedAccount<'info>,

    /// CHECK: optional orphan pool PDA for the level
    #[account(mut)]
    pub orphan_pool: UncheckedAccount<'info>,

    /// CHECK: pending orphan PDA for the level (must match global)
    #[account(mut)]
    pub pending_orphan_pda: UncheckedAccount<'info>,

    /// CHECK: treasury account
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    /// Optional: campaign token ATA for the level (source of COCO rewards)
    #[account(mut)]
    pub campaign_token_ata: UncheckedAccount<'info>,

    /// Optional: destination token ATAs
    #[account(mut)]
    pub user_token_ata: UncheckedAccount<'info>,

    #[account(mut)]
    pub referrer_token_ata: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimOrphans<'info> {
    #[account(mut)]
    pub claimer: Signer<'info>,

    #[account(mut, seeds = [b"global-config"], bump = global.bump)]
    pub global: Account<'info, GlobalConfig>,

    #[account(mut, seeds = [b"user", claimer.key().as_ref()], bump = user_account.bump)]
    pub user_account: Account<'info, UserAccount>,

    /// CHECK: owner of the user_account (destination for orphan-parent payouts)
    #[account(mut)]
    pub user_owner: UncheckedAccount<'info>,

    /// CHECK: orphan pool PDA for the level
    #[account(mut)]
    pub orphan_pool: UncheckedAccount<'info>,

    /// CHECK: pending orphan PDA for the level (must match global)
    #[account(mut)]
    pub pending_orphan_pda: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn claim_orphans(
    ctx: Context<ClaimOrphans>,
    level: u8,
    max_to_claim: u8,
    allow_immediate: bool,
) -> Result<()> {
    if level == 0 || level as usize > MAX_LEVELS {
        return Err(ErrorCode::InvalidLevel.into());
    }
    let idx = (level - 1) as usize;

    let global = &mut ctx.accounts.global;
    let user = &mut ctx.accounts.user_account;

    if !user.activated[idx] {
        return Err(ErrorCode::InvalidLevel.into());
    }

    let clock = Clock::get()?;
    let allow_immediate_flag = user.immediate_assign[idx] && allow_immediate;
    let mut eligible_by_time = false;
    if user.activation_timestamps[idx] != 0 {
        let elapsed = clock
            .unix_timestamp
            .checked_sub(user.activation_timestamps[idx])
            .unwrap_or(0);
        if elapsed >= global.orphan_assignment_delay_seconds as i64 {
            eligible_by_time = true;
        }
    }

    if !(allow_immediate_flag || eligible_by_time) {
        return Err(ErrorCode::InvalidLevel.into());
    }

    // ensure pending orphan pda matches global
    if ctx.accounts.pending_orphan_pda.to_account_info().key != &global.pending_orphan_pdas[idx] {
        return Err(ErrorCode::PendingOrphanMismatch.into());
    }

    // fetch orphan pool
    let mut pool = Account::<OrphanPool>::try_from(&ctx.accounts.orphan_pool.to_account_info())?;

    let free_slots = global
        .slot_count
        .checked_sub(user.referral_slots_used[idx])
        .unwrap_or(0) as usize;
    let to_claim = std::cmp::min(free_slots, max_to_claim as usize);

    let p_bump = global.pending_orphan_bumps[idx];
    let mut claimed = 0usize;
    let parent_share = calc_share(global.level_prices[idx], global.orphan_parent_bps);

    while claimed < to_claim && !pool.queue.is_empty() {
        let orphan_pk = pool.queue.remove(0);

        if global.pending_orphan_totals[idx] < parent_share {
            return Err(ErrorCode::InsufficientPendingOrphanBalance.into());
        }

        // transfer lamports from pending orphan PDA (PDA signs) to parent owner
        let ix = system_instruction::transfer(
            ctx.accounts.pending_orphan_pda.to_account_info().key,
            ctx.accounts.user_owner.to_account_info().key,
            parent_share,
        );

        let level_b: &[u8] = &[level];
        let bump_b: &[u8] = &[p_bump];
        let seeds: &[&[u8]] = &[b"pending-orphan".as_ref(), level_b, bump_b];
        let signer: &[&[&[u8]]] = &[&seeds];
        invoke_signed(
            &ix,
            &[
                ctx.accounts.pending_orphan_pda.to_account_info().clone(),
                ctx.accounts.user_owner.to_account_info().clone(),
                ctx.accounts.system_program.to_account_info().clone(),
            ],
            signer,
        )?;

        user.referral_slots_used[idx] = user.referral_slots_used[idx].checked_add(1).unwrap();
        global.pending_orphan_totals[idx] = global.pending_orphan_totals[idx]
            .checked_sub(parent_share)
            .unwrap();
        emit!(OrphanAssigned {
            orphan: orphan_pk,
            parent: *ctx.accounts.user_owner.to_account_info().key,
            level,
            amount: parent_share
        });
        claimed = claimed.checked_add(1).unwrap();
    }

    // write back pool
    let pool_info = &mut ctx.accounts.orphan_pool.to_account_info();
    let mut pool_account = pool;
    // TODO: write back via serialization helper if needed (Anchor auto-writes Account<T> changes when mutated)
    // (Account::<OrphanPool>::try_from already gave us a mutable object and changes to it will be saved)

    Ok(())
}

#[derive(Accounts)]
pub struct SetImmediateAssign<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(mut, seeds = [b"user", signer.key().as_ref()], bump = user_account.bump)]
    pub user_account: Account<'info, UserAccount>,
}

pub fn set_immediate_assign(
    ctx: Context<SetImmediateAssign>,
    level: u8,
    enabled: bool,
) -> Result<()> {
    if level == 0 || level as usize > MAX_LEVELS {
        return Err(ErrorCode::InvalidLevel.into());
    }
    let idx = (level - 1) as usize;
    let user = &mut ctx.accounts.user_account;
    user.immediate_assign[idx] = enabled;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminSetUserActivationTimestamp<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub user_account: Account<'info, UserAccount>,
}

pub fn admin_set_user_activation_timestamp(
    ctx: Context<AdminSetUserActivationTimestamp>,
    level: u8,
    ts: i64,
) -> Result<()> {
    if level == 0 || level as usize > MAX_LEVELS {
        return Err(ErrorCode::InvalidLevel.into());
    }
    let idx = (level - 1) as usize;
    let user = &mut ctx.accounts.user_account;
    user.activation_timestamps[idx] = ts;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminSetUserDailyCounters<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub user_account: Account<'info, UserAccount>,
}

pub fn admin_set_user_daily_counters(
    ctx: Context<AdminSetUserDailyCounters>,
    last_daily_reset_ts: i64,
    daily_committed_total: u64,
) -> Result<()> {
    let user = &mut ctx.accounts.user_account;
    user.last_daily_reset_ts = last_daily_reset_ts;
    user.daily_committed_total = daily_committed_total;
    Ok(())
}

#[derive(Accounts)]
pub struct AdminSetUserCommits<'info> {
    pub admin: Signer<'info>,
    #[account(mut)]
    pub user_account: Account<'info, UserAccount>,
}

pub fn admin_set_user_commits(
    ctx: Context<AdminSetUserCommits>,
    last_commit_window_ts: i64,
    commits_in_window: u8,
) -> Result<()> {
    let user = &mut ctx.accounts.user_account;
    user.last_commit_window_ts = last_commit_window_ts;
    user.commits_in_window = commits_in_window;
    Ok(())
}

pub fn commit_level(
    ctx: Context<CommitLevel>,
    level: u8,
    referrer: Option<Pubkey>,
    immediate_orphan_assign: bool,
) -> Result<()> {
    // Basic validation
    if level == 0 || level as usize > MAX_LEVELS {
        return Err(ErrorCode::InvalidLevel.into());
    }

    let idx = (level - 1) as usize;
    let global = &mut ctx.accounts.global;
    let user = &mut ctx.accounts.user_account;

    // Prevent double activation
    if user.activated[idx] {
        return Err(ErrorCode::AlreadyActivated.into());
    }

    // Validate sequential progression
    if user.highest_level + 1 != level {
        return Err(ErrorCode::InvalidLevel.into());
    }

    // Anti-gaming checks: rate-limiting per minute and daily cap
    let clock = Clock::get()?;
    // minute window
    let window_ts = clock.unix_timestamp / 60; // minute resolution
    if user.last_commit_window_ts != window_ts {
        user.last_commit_window_ts = window_ts;
        user.commits_in_window = 0u8;
    }

    // increment optimistic commits count and check
    let new_commits = user
        .commits_in_window
        .checked_add(1)
        .ok_or(ErrorCode::RateLimitExceeded)?;
    if new_commits > global.per_wallet_max_commits_per_minute {
        return Err(ErrorCode::RateLimitExceeded.into());
    }

    // daily cap reset
    if user.last_daily_reset_ts == 0 || clock.unix_timestamp - user.last_daily_reset_ts >= 86400 {
        user.daily_committed_total = 0u64;
        user.last_daily_reset_ts = clock.unix_timestamp;
    }

    let price = global.level_prices[idx];
    // check daily cap
    if user
        .daily_committed_total
        .checked_add(price)
        .unwrap_or(u64::MAX)
        > global.per_wallet_daily_cap
    {
        return Err(ErrorCode::DailyCapExceeded.into());
    }

    // Determine referral vs orphan
    let mut is_referral = false;
    // If referrer provided, attempt to parse referrer account
    let mut referrer_pubkey: Option<Pubkey> = None;
    if let Some(ref_pk) = referrer {
        // ensure not self-referral
        if ref_pk == *ctx.accounts.payer.key() {
            return Err(ErrorCode::SelfReferral.into());
        }

        // check referrer_user_account matches provided pubkey and has level active
        if ctx.accounts.referrer_user_account.to_account_info().key == &ref_pk {
            // try to deserialize as UserAccount
            if let Ok(mut ref_acc) = Account::<UserAccount>::try_from(
                &ctx.accounts.referrer_user_account.to_account_info(),
            ) {
                if ref_acc.activated[idx] && ref_acc.referral_slots_used[idx] < global.slot_count {
                    // referral case
                    is_referral = true;
                    // increment slot usage
                    ref_acc.referral_slots_used[idx] =
                        ref_acc.referral_slots_used[idx].checked_add(1).unwrap();
                    referrer_pubkey = Some(ref_pk);
                }
            }
        }
    }

    // Compute splits and perform SOL transfers
    if is_referral {
        let ref_share = calc_share(price, global.referral_referrer_bps);
        let home_share = price.checked_sub(ref_share).unwrap();

        // Transfer referrer share (to referrer account pubkey)
        let ix_ref = system_instruction::transfer(
            ctx.accounts.payer.key(),
            ctx.accounts.referrer_user_account.to_account_info().key,
            ref_share,
        );
        invoke_signed(
            &ix_ref,
            &[
                ctx.accounts.payer.to_account_info().clone(),
                ctx.accounts.referrer_user_account.to_account_info().clone(),
                ctx.accounts.system_program.to_account_info().clone(),
            ],
            &[],
        )?;

        // Transfer home share to treasury
        let ix_home = system_instruction::transfer(
            ctx.accounts.payer.key(),
            ctx.accounts.treasury.to_account_info().key,
            home_share,
        );
        invoke_signed(
            &ix_home,
            &[
                ctx.accounts.payer.to_account_info().clone(),
                ctx.accounts.treasury.to_account_info().clone(),
                ctx.accounts.system_program.to_account_info().clone(),
            ],
            &[],
        )?;

        // Explicit remainder handling (if any rounding left)
        let transferred_total = ref_share.checked_add(home_share).unwrap_or(0);
        let remainder = price.checked_sub(transferred_total).unwrap_or(0);
        if remainder > 0 {
            let ix_rem = system_instruction::transfer(
                ctx.accounts.payer.key(),
                ctx.accounts.treasury.to_account_info().key,
                remainder,
            );
            invoke_signed(
                &ix_rem,
                &[
                    ctx.accounts.payer.to_account_info().clone(),
                    ctx.accounts.treasury.to_account_info().clone(),
                    ctx.accounts.system_program.to_account_info().clone(),
                ],
                &[],
            )?;
        }

        // Transfer COCO reward from campaign ATA to user token ATA
        let coco_amount = global.coco_rewards[idx];
        if coco_amount > 0 && ctx.accounts.campaign_token_ata.to_account_info().data_len() > 0 {
            let cpi_accounts = token::Transfer {
                from: ctx.accounts.campaign_token_ata.to_account_info().clone(),
                to: ctx.accounts.user_token_ata.to_account_info().clone(),
                authority: ctx.accounts.global.to_account_info().clone(),
            };
            let seeds: &[&[u8]] = &[b"global-config".as_ref(), &[global.bump]];
            let signer: &[&[&[u8]]] = &[&seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                cpi_accounts,
                signer,
            );
            token::transfer(cpi_ctx, coco_amount)?;

            // Optionally also send reward to referrer (policy can be same or separate)
            // For MVP we skip referrer token reward
        }

        // mark user activated
        user.activated[idx] = true;
        user.highest_level = level;

        // record activation timestamp
        let clock = Clock::get()?;
        user.activation_timestamps[idx] = clock.unix_timestamp;

        // finalize anti-gaming counters: increment commits_in_window and daily total
        user.commits_in_window = user
            .commits_in_window
            .checked_add(1)
            .unwrap_or(user.commits_in_window);
        user.daily_committed_total = user
            .daily_committed_total
            .checked_add(price)
            .unwrap_or(user.daily_committed_total);

        emit!(CommitEvent {
            user: *ctx.accounts.payer.key(),
            level,
            lamports: price,
            referrer: referrer_pubkey
        });
        emit!(SplitEvent {
            home: home_share,
            referrer: Some(ref_share),
            orphan_pool: None
        });

        // After activation, attempt auto-assign orphans to this user if they have slots and are eligible
        if ctx.accounts.orphan_pool.to_account_info().data_len() > 0 {
            // evaluate assignment eligibility
            let allow_immediate = immediate_orphan_assign || user.immediate_assign[idx];
            let mut eligible_by_time = false;
            if user.activation_timestamps[idx] != 0 {
                let elapsed = clock
                    .unix_timestamp
                    .checked_sub(user.activation_timestamps[idx])
                    .unwrap_or(0);
                if elapsed >= global.orphan_assignment_delay_seconds as i64 {
                    eligible_by_time = true;
                }
            }

            if allow_immediate || eligible_by_time {
                if let Ok(mut pool) =
                    Account::<OrphanPool>::try_from(&ctx.accounts.orphan_pool.to_account_info())
                {
                    // verify pending orphan PDA matches global config
                    if ctx.accounts.pending_orphan_pda.key() != global.pending_orphan_pdas[idx] {
                        return Err(ErrorCode::PendingOrphanMismatch.into());
                    }
                    let p_bump = global.pending_orphan_bumps[idx];
                    while (user.referral_slots_used[idx] < global.slot_count)
                        && !pool.queue.is_empty()
                    {
                        let orphan_pk = pool.queue.remove(0);
                        // transfer parent_share from pending orphan PDA to this user (user_owner)
                        let parent_share =
                            calc_share(global.level_prices[idx], global.orphan_parent_bps);

                        // ensure pending orphan totals has enough
                        if global.pending_orphan_totals[idx] < parent_share {
                            return Err(ErrorCode::InsufficientPendingOrphanBalance.into());
                        }

                        // transfer lamports from pending orphan PDA (PDA signs) to parent owner
                        let ix = system_instruction::transfer(
                            ctx.accounts.pending_orphan_pda.to_account_info().key,
                            ctx.accounts.user_owner.to_account_info().key,
                            parent_share,
                        );

                        let level_b: &[u8] = &[level];
                        let bump_b: &[u8] = &[p_bump];
                        let seeds: &[&[u8]] = &[b"pending-orphan".as_ref(), level_b, bump_b];
                        let signer: &[&[&[u8]]] = &[&seeds];
                        invoke_signed(
                            &ix,
                            &[
                                ctx.accounts.pending_orphan_pda.to_account_info().clone(),
                                ctx.accounts.user_owner.to_account_info().clone(),
                                ctx.accounts.system_program.to_account_info().clone(),
                            ],
                            signer,
                        )?;

                        user.referral_slots_used[idx] =
                            user.referral_slots_used[idx].checked_add(1).unwrap();
                        global.pending_orphan_totals[idx] = global.pending_orphan_totals[idx]
                            .checked_sub(parent_share)
                            .unwrap();
                        emit!(OrphanAssigned {
                            orphan: orphan_pk,
                            parent: *ctx.accounts.user_owner.to_account_info().key,
                            level,
                            amount: parent_share
                        });
                    }
                }
            }
        }

        Ok(())
    } else {
        // Orphan case
        let parent_share = calc_share(price, global.orphan_parent_bps);
        let home_share = price.checked_sub(parent_share).unwrap();

        // Push to orphan pool queue if provided (best-effort)
        if ctx.accounts.orphan_pool.to_account_info().data_len() > 0 {
            // attempt to deserialize
            if let Ok(mut pool) =
                Account::<OrphanPool>::try_from(&ctx.accounts.orphan_pool.to_account_info())
            {
                pool.queue.push(*ctx.accounts.payer.key());
            }
        }

        // Transfer parent_share to pending orphan PDA
        if ctx.accounts.pending_orphan_pda.to_account_info().key != &global.pending_orphan_pdas[idx]
        {
            return Err(ErrorCode::PendingOrphanMismatch.into());
        }
        let ix_parent = system_instruction::transfer(
            ctx.accounts.payer.key(),
            ctx.accounts.pending_orphan_pda.to_account_info().key,
            parent_share,
        );
        invoke_signed(
            &ix_parent,
            &[
                ctx.accounts.payer.to_account_info().clone(),
                ctx.accounts.pending_orphan_pda.to_account_info().clone(),
                ctx.accounts.system_program.to_account_info().clone(),
            ],
            &[],
        )?;
        // update pending totals
        global.pending_orphan_totals[idx] = global.pending_orphan_totals[idx]
            .checked_add(parent_share)
            .unwrap();

        // Transfer home share to treasury
        let ix_home = system_instruction::transfer(
            ctx.accounts.payer.key(),
            ctx.accounts.treasury.to_account_info().key,
            home_share,
        );
        invoke_signed(
            &ix_home,
            &[
                ctx.accounts.payer.to_account_info().clone(),
                ctx.accounts.treasury.to_account_info().clone(),
                ctx.accounts.system_program.to_account_info().clone(),
            ],
            &[],
        )?;

        // Explicit remainder handling (if any rounding left)
        let transferred_total = parent_share.checked_add(home_share).unwrap_or(0);
        let remainder = price.checked_sub(transferred_total).unwrap_or(0);
        if remainder > 0 {
            let ix_rem = system_instruction::transfer(
                ctx.accounts.payer.key(),
                ctx.accounts.treasury.to_account_info().key,
                remainder,
            );
            invoke_signed(
                &ix_rem,
                &[
                    ctx.accounts.payer.to_account_info().clone(),
                    ctx.accounts.treasury.to_account_info().clone(),
                    ctx.accounts.system_program.to_account_info().clone(),
                ],
                &[],
            )?;
        }

        // Transfer COCO reward to user
        let coco_amount = global.coco_rewards[idx];
        if coco_amount > 0 && ctx.accounts.campaign_token_ata.to_account_info().data_len() > 0 {
            let cpi_accounts = token::Transfer {
                from: ctx.accounts.campaign_token_ata.to_account_info().clone(),
                to: ctx.accounts.user_token_ata.to_account_info().clone(),
                authority: ctx.accounts.global.to_account_info().clone(), // global must be authority in practice
            };
            let seeds: &[&[u8]] = &[b"global-config".as_ref(), &[global.bump]];
            let signer: &[&[&[u8]]] = &[&seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info().clone(),
                cpi_accounts,
                signer,
            );
            token::transfer(cpi_ctx, coco_amount)?;
        }

        // mark user activated
        user.activated[idx] = true;
        user.highest_level = level;

        // record activation timestamp
        let clock = Clock::get()?;
        user.activation_timestamps[idx] = clock.unix_timestamp;

        emit!(CommitEvent {
            user: *ctx.accounts.payer.key(),
            level,
            lamports: price,
            referrer: None
        });
        emit!(SplitEvent {
            home: home_share,
            referrer: None,
            orphan_pool: Some(parent_share)
        });

        // After activation, attempt auto-assign orphans to this user if they have slots and are eligible
        if ctx.accounts.orphan_pool.to_account_info().data_len() > 0 {
            // evaluate assignment eligibility
            let allow_immediate = immediate_orphan_assign || user.immediate_assign[idx];
            let mut eligible_by_time = false;
            if user.activation_timestamps[idx] != 0 {
                let elapsed = clock
                    .unix_timestamp
                    .checked_sub(user.activation_timestamps[idx])
                    .unwrap_or(0);
                if elapsed >= global.orphan_assignment_delay_seconds as i64 {
                    eligible_by_time = true;
                }
            }

            if allow_immediate || eligible_by_time {
                if let Ok(mut pool) =
                    Account::<OrphanPool>::try_from(&ctx.accounts.orphan_pool.to_account_info())
                {
                    // verify pending orphan PDA matches global config
                    if ctx.accounts.pending_orphan_pda.to_account_info().key
                        != &global.pending_orphan_pdas[idx]
                    {
                        return Err(ErrorCode::PendingOrphanMismatch.into());
                    }
                    let p_bump = global.pending_orphan_bumps[idx];
                    while (user.referral_slots_used[idx] < global.slot_count)
                        && !pool.queue.is_empty()
                    {
                        let orphan_pk = pool.queue.remove(0);

                        // transfer parent_share from pending orphan PDA to parent owner
                        let parent_share =
                            calc_share(global.level_prices[idx], global.orphan_parent_bps);

                        // ensure pending orphan totals has enough
                        if global.pending_orphan_totals[idx] < parent_share {
                            return Err(ErrorCode::InsufficientPendingOrphanBalance.into());
                        }

                        // transfer lamports from pending orphan PDA (PDA signs) to parent owner
                        let ix = system_instruction::transfer(
                            ctx.accounts.pending_orphan_pda.to_account_info().key,
                            ctx.accounts.user_owner.to_account_info().key,
                            parent_share,
                        );

                        let level_b: &[u8] = &[level];
                        let bump_b: &[u8] = &[p_bump];
                        let seeds: &[&[u8]] = &[b"pending-orphan".as_ref(), level_b, bump_b];
                        let signer: &[&[&[u8]]] = &[&seeds];
                        invoke_signed(
                            &ix,
                            &[
                                ctx.accounts.pending_orphan_pda.to_account_info().clone(),
                                ctx.accounts.user_owner.to_account_info().clone(),
                                ctx.accounts.system_program.to_account_info().clone(),
                            ],
                            signer,
                        )?;

                        user.referral_slots_used[idx] =
                            user.referral_slots_used[idx].checked_add(1).unwrap();
                        global.pending_orphan_totals[idx] = global.pending_orphan_totals[idx]
                            .checked_sub(parent_share)
                            .unwrap();
                        emit!(OrphanAssigned {
                            orphan: orphan_pk,
                            parent: *ctx.accounts.user_owner.to_account_info().key,
                            level,
                            amount: parent_share
                        });
                    }
                }
            }
        }

        Ok(())
    }
}
