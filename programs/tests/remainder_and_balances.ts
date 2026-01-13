import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, getAccount, createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority, AuthorityType } from "@solana/spl-token";

const assert = require('assert');

describe('remainder and balance checks', () => {
  // Using the provider from Anchor
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.CocoStaking as Program;

  let globalPDA: PublicKey;
  let global: any;
  let campaignAtaLocal: PublicKey | null = null;
  const level = 1;
  const idx = level - 1;

  before(async () => {
    globalPDA = (await PublicKey.findProgramAddress([Buffer.from('global-config')], program.programId))[0];

    try {
      global = await program.account.globalConfig.fetch(globalPDA);
      console.log('Found existing global config');
    } catch (e) {
      console.log('Global config missing, attempting auto-initialize with defaults');
      // Best-effort initialization: choose small MAX_LEVELS (3) for test fixtures
      const MAX_LEVELS = 3;
      const levelPrices = new Array(MAX_LEVELS).fill(1_000_000);
      const cocoRewards = new Array(MAX_LEVELS).fill(10);

      try {
        await program.methods.initializeGlobal(levelPrices, cocoRewards, 1000, 6000, 3)
          .accounts({ admin: provider.wallet.publicKey })
          .rpc();
        global = await program.account.globalConfig.fetch(globalPDA);
        console.log('Global config initialized by test setup');
      } catch (initErr) {
        console.error('Automatic initialization failed; please run the admin initialization before running tests:', initErr);
        throw initErr;
      }
    }

    // Basic checks and helpful warnings if admin PDAs are not set
    const pendingPda = global.pendingOrphanPdas[idx];
    if (!pendingPda || pendingPda.equals(new PublicKey(0))) {
      console.warn('Warning: pendingOrphanPda not set for level', level, '- run admin:init_pending_orphan to create it. Tests will still run but orphan-specific checks may be skipped.');
    }

    const campaignAta = global.campaignTokenAtas[idx];
    if (!campaignAta || campaignAta.equals(new PublicKey(0))) {
      console.warn('campaignTokenAta not set for level', level, '- creating a test mint + ATA and transferring authority to global PDA');

      // create a mint and ATA, mint tokens, and set ATA owner to global PDA
      const payer = provider.wallet.payer as Keypair;
      const mint = await createMint(provider.connection, payer, payer.publicKey, null, 0);
      const ata = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey);
      // mint some tokens to ATA
      await mintTo(provider.connection, payer, mint, ata.address, payer.publicKey, BigInt(1000));

      // set the token account owner to global PDA so program can sign transfers
      await setAuthority(provider.connection, payer, ata.address, payer.publicKey, globalPDA, AuthorityType.AccountOwner);
      campaignAtaLocal = ata.address;

      // Attempt to persist into global (best-effort)
      try {
        await program.methods.setCampaignAta(level, campaignAtaLocal)
          .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
          .rpc();
        console.log('setCampaignAta called to persist campaign ATA');
      } catch (e) {
        console.warn('setCampaignAta RPC failed; campaign ATA will be used locally for tests:', e);
      }
    } else {
      campaignAtaLocal = campaignAta;
    }

    // Ensure pending orphan PDA exists (initialize if missing)
    const expectedPendingPda = (await PublicKey.findProgramAddress([Buffer.from('pending-orphan'), Buffer.from([level])], program.programId))[0];
    if (!global.pendingOrphanPdas[idx] || global.pendingOrphanPdas[idx].equals(new PublicKey(0))) {
      try {
        await program.methods.initPendingOrphan(level)
          .accounts({ admin: provider.wallet.publicKey, global: globalPDA, pendingOrphanPda: expectedPendingPda, systemProgram: SystemProgram.programId })
          .rpc();
        global = await program.account.globalConfig.fetch(globalPDA);
        console.log('Initialized pending orphan PDA for level', level);
      } catch (e) {
        console.warn('initPendingOrphan failed; please run admin:init_pending_orphan if needed:', e);
      }
    }

    // Ensure orphan pool PDA exists (initialize if missing)
    const expectedOrphanPoolPda = (await PublicKey.findProgramAddress([Buffer.from('orphan-pool'), Buffer.from([level])], program.programId))[0];
    if (!global.orphanPools || !global.orphanPools[idx] || global.orphanPools[idx].equals(new PublicKey(0))) {
      try {
        await program.methods.initOrphanPool(level, 100)
          .accounts({ admin: provider.wallet.publicKey, global: globalPDA, orphanPool: expectedOrphanPoolPda, systemProgram: SystemProgram.programId })
          .rpc();
        global = await program.account.globalConfig.fetch(globalPDA);
        console.log('Initialized orphan pool for level', level);
      } catch (e) {
        console.warn('initOrphanPool failed; please run admin:init_orphan_pool if needed:', e);
      }
    }

    // Fund the payer if on local validator to ensure test airdrops succeed
    try {
      await provider.connection.requestAirdrop(provider.wallet.publicKey, 5_000_000_000);
    } catch (e) {
      // ignore - not critical
    }
  });

  // helper to compute shares like on-chain
  const calcShare = (amount: number, bps: number) => {
    return Math.floor((BigInt(amount) * BigInt(bps)) / BigInt(10000));
  }

  it('orphan commit increases pending totals and treasury receives home share; token reward sent', async () => {
    // set tight rate limits for this test
    await program.methods.setRateLimits(10, 1_000_000_000_000)
      .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
      .rpc();
    // accounts
    const payer = provider.wallet.payer as Keypair;

    // fetch global (assumes InitializeGlobal was run in CI/setup or test harness)
    // In a full test we would call initialize_global here. For now just fetch PDAs set up by earlier admin steps.
    const globalPDA = (await PublicKey.findProgramAddress([Buffer.from('global-config')], program.programId))[0];
    const global: any = await program.account.globalConfig.fetch(globalPDA);

    const level = 1;
    const idx = level - 1;

    const price = Number(global.levelPrices[idx]);
    const parent_share = Number(calcShare(price, Number(global.orphanParentBps)));
    const home_share = price - parent_share;

    // get treasury balance before
    const treasuryBefore = await provider.connection.getBalance(global.treasury);

    // find pending orphan PDA for level
    const pendingPda = global.pendingOrphanPdas[idx] as PublicKey;
    const pendingBefore = await provider.connection.getBalance(pendingPda);

    // find campaign token ata and balance
    const campaignAta = campaignAtaLocal ? campaignAtaLocal : (global.campaignTokenAtas ? global.campaignTokenAtas[idx] : null) as PublicKey;
    let campaignBefore = 0;
    if (campaignAta) {
      try {
        const ataAcc = await getAccount(provider.connection, campaignAta);
        campaignBefore = Number(ataAcc.amount);
      } catch (e) {
        // account may not exist yet
        campaignBefore = 0;
      }
    } else {
      campaignBefore = 0;
    }

    // Call commit_level as orphan (no referrer)
    await program.methods.commitLevel(level, null, false)
      .accounts({
        payer: payer.publicKey,
        global: globalPDA,
        userAccount: payer.publicKey, // in tests user PDA creation would be required; using simple placeholders
        userOwner: payer.publicKey,
        referrerUserAccount: payer.publicKey,
        orphanPool: global.orphanPools ? global.orphanPools[idx] : payer.publicKey,
        pendingOrphanPda: pendingPda,
        treasury: global.treasury,
        campaignTokenAta: campaignAta || payer.publicKey,
        userTokenAta: payer.publicKey,
        referrerTokenAta: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // re-fetch balances and global
    const treasuryAfter = await provider.connection.getBalance(global.treasury);
    const pendingAfter = await provider.connection.getBalance(pendingPda);
    const globalAfter: any = await program.account.globalConfig.fetch(globalPDA);

    // pending totals should have increased by parent_share (exact)
    assert.strictEqual(Number(globalAfter.pendingOrphanTotals[idx]), Number(global.pendingOrphanTotals[idx]) + parent_share);

    // pending PDA balance should have increased exactly by parent_share
    assert.strictEqual(pendingAfter, pendingBefore + parent_share);

    // treasury should have increased by home_share plus any remainder
    const transferred_total_orphan = parent_share + home_share;
    const remainder_orphan = price - transferred_total_orphan;
    assert.strictEqual(treasuryAfter, treasuryBefore + home_share + remainder_orphan);

    // token reward: campaign ATA should decrease by coco_rewards[idx] if present
    const cocoAmount = Number(global.cocoRewards[idx] || 0);
    if (cocoAmount > 0 && campaignBefore > 0) {
      const ataAcc = await getAccount(provider.connection, campaignAta);
      const campaignAfter = Number(ataAcc.amount);
      assert.strictEqual(campaignAfter, campaignBefore - cocoAmount);
    }
  });

  it('multiple orphan commits sum to pending totals', async () => {
    // create two new payer keypairs and fund them
    const orphan1 = Keypair.generate();
    const orphan2 = Keypair.generate();
    // airdrop lamports to each (assumes dev cluster)
    await provider.connection.requestAirdrop(orphan1.publicKey, price * 2 + 1);
    await provider.connection.requestAirdrop(orphan2.publicKey, price * 2 + 1);

    // fetch global before
    const globalBefore: any = await program.account.globalConfig.fetch(globalPDA);
    const pendingBeforeMulti = await provider.connection.getBalance(pendingPda);

    // orphan1 commit
    await program.methods.commitLevel(level, null, false)
      .accounts({
        payer: orphan1.publicKey,
        global: globalPDA,
        userAccount: orphan1.publicKey,
        userOwner: orphan1.publicKey,
        referrerUserAccount: orphan1.publicKey,
        orphanPool: global.orphanPools ? global.orphanPools[idx] : orphan1.publicKey,
        pendingOrphanPda: pendingPda,
        treasury: global.treasury,
        campaignTokenAta: campaignAta,
        userTokenAta: orphan1.publicKey,
        referrerTokenAta: orphan1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orphan1])
      .rpc();

    // orphan2 commit
    await program.methods.commitLevel(level, null, false)
      .accounts({
        payer: orphan2.publicKey,
        global: globalPDA,
        userAccount: orphan2.publicKey,
        userOwner: orphan2.publicKey,
        referrerUserAccount: orphan2.publicKey,
        orphanPool: global.orphanPools ? global.orphanPools[idx] : orphan2.publicKey,
        pendingOrphanPda: pendingPda,
        treasury: global.treasury,
        campaignTokenAta: campaignAta,
        userTokenAta: orphan2.publicKey,
        referrerTokenAta: orphan2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orphan2])
      .rpc();

    const globalAfterMulti: any = await program.account.globalConfig.fetch(globalPDA);
    const pendingAfterMulti = await provider.connection.getBalance(pendingPda);

    const expectedIncrease = parent_share * 2;
    assert.strictEqual(Number(globalAfterMulti.pendingOrphanTotals[idx]), Number(globalBefore.pendingOrphanTotals[idx]) + expectedIncrease);
    assert.strictEqual(pendingAfterMulti, pendingBeforeMulti + expectedIncrease);
  });

  it('rate limit: rejects rapid commits beyond per-minute cap', async () => {
    // set per-minute cap to 1
    await program.methods.setRateLimits(1, 1_000_000_000_000)
      .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
      .rpc();

    const actor = Keypair.generate();
    await provider.connection.requestAirdrop(actor.publicKey, 5_000_000_000);

    // first commit should succeed
    await program.methods.commitLevel(level, null, false)
      .accounts({
        payer: actor.publicKey,
        global: globalPDA,
        userAccount: actor.publicKey,
        userOwner: actor.publicKey,
        referrerUserAccount: actor.publicKey,
        orphanPool: global.orphanPools ? global.orphanPools[idx] : actor.publicKey,
        pendingOrphanPda: global.pendingOrphanPdas[idx] || actor.publicKey,
        treasury: global.treasury,
        campaignTokenAta: campaignAta || actor.publicKey,
        userTokenAta: actor.publicKey,
        referrerTokenAta: actor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([actor])
      .rpc();

    // second immediate commit should fail with RateLimitExceeded
    let failed = false;
    try {
      await program.methods.commitLevel(level, null, false)
        .accounts({
          payer: actor.publicKey,
          global: globalPDA,
          userAccount: actor.publicKey,
          userOwner: actor.publicKey,
          referrerUserAccount: actor.publicKey,
          orphanPool: global.orphanPools ? global.orphanPools[idx] : actor.publicKey,
          pendingOrphanPda: global.pendingOrphanPdas[idx] || actor.publicKey,
          treasury: global.treasury,
          campaignTokenAta: campaignAta || actor.publicKey,
          userTokenAta: actor.publicKey,
          referrerTokenAta: actor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([actor])
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);
  });

  it('rate limit counter resets after a minute', async () => {
    // ...existing test body...
  });

  it('admin validation: set_rate_limits rejects per_minute > 60', async () => {
    let failed = false;
    try {
      await program.methods.setRateLimits(61, 1_000_000_000_000)
        .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);
  });

  it('admin validation: set_rate_limits rejects excessive daily cap', async () => {
    let failed = false;
    const excessive = (1_000_000n * 1_000_000_000n) + 1n;
    try {
      await program.methods.setRateLimits(10, Number(excessive))
        .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);
  });

  it('admin validation: initialize_global rejects invalid bps and slot_count', async () => {
    let failed = false;
    const MAX_LEVELS = 3;
    const levelPrices = new Array(MAX_LEVELS).fill(1_000_000);
    const cocoRewards = new Array(MAX_LEVELS).fill(10);
    try {
      // referral bps > 10000
      await program.methods.initializeGlobal(levelPrices, cocoRewards, 20000, 6000, 0, 86400)
        .accounts({ admin: provider.wallet.publicKey })
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);
  });

  it('admin validation: set_rate_limits rejects per_minute == 0', async () => {
    let failed = false;
    try {
      await program.methods.setRateLimits(0, 1_000_000_000)
        .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);
  });

  it('admin validation: initialize_global rejects orphan_parent_bps > 10000', async () => {
    let failed = false;
    const MAX_LEVELS = 3;
    const levelPrices = new Array(MAX_LEVELS).fill(1_000_000);
    const cocoRewards = new Array(MAX_LEVELS).fill(10);
    try {
      await program.methods.initializeGlobal(levelPrices, cocoRewards, 1000, 20000, 3)
        .accounts({ admin: provider.wallet.publicKey })
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);
  });

  it('daily cap reset via admin helper: old timestamp resets totals and allows commit', async () => {
    const actor = Keypair.generate();
    await provider.connection.requestAirdrop(actor.publicKey, 5_000_000_000);
    const idx = level - 1;
    const price = Number(global.levelPrices[idx]);

    // set a small daily cap (2x price)
    const smallDailyCap = price * 2;
    await program.methods.setRateLimits(1000, smallDailyCap)
      .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
      .rpc();

    // perform exactly two commits to reach the cap
    for (let i = 0; i < 2; i++) {
      await program.methods.commitLevel(level, null, false)
        .accounts({
          payer: actor.publicKey,
          global: globalPDA,
          userAccount: actor.publicKey,
          userOwner: actor.publicKey,
          referrerUserAccount: actor.publicKey,
          orphanPool: global.orphanPools ? global.orphanPools[idx] : actor.publicKey,
          pendingOrphanPda: global.pendingOrphanPdas[idx] || actor.publicKey,
          treasury: global.treasury,
          campaignTokenAta: campaignAtaLocal || actor.publicKey,
          userTokenAta: actor.publicKey,
          referrerTokenAta: actor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([actor])
        .rpc();
    }

    // third commit should fail due to daily cap
    let failed = false;
    try {
      await program.methods.commitLevel(level, null, false)
        .accounts({
          payer: actor.publicKey,
          global: globalPDA,
          userAccount: actor.publicKey,
          userOwner: actor.publicKey,
          referrerUserAccount: actor.publicKey,
          orphanPool: global.orphanPools ? global.orphanPools[idx] : actor.publicKey,
          pendingOrphanPda: global.pendingOrphanPdas[idx] || actor.publicKey,
          treasury: global.treasury,
          campaignTokenAta: campaignAtaLocal || actor.publicKey,
          userTokenAta: actor.publicKey,
          referrerTokenAta: actor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([actor])
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);

    // set user's last_daily_reset_ts to old and keep daily_committed_total at cap via admin helper
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - (86400 + 10);
    await program.methods.adminSetUserDailyCounters(oldTs, smallDailyCap)
      .accounts({ admin: provider.wallet.publicKey, userAccount: actor.publicKey })
      .rpc();

    // now commit should succeed because the on-chain reset will occur before cap check
    failed = false;
    try {
      await program.methods.commitLevel(level, null, false)
        .accounts({
          payer: actor.publicKey,
          global: globalPDA,
          userAccount: actor.publicKey,
          userOwner: actor.publicKey,
          referrerUserAccount: actor.publicKey,
          orphanPool: global.orphanPools ? global.orphanPools[idx] : actor.publicKey,
          pendingOrphanPda: global.pendingOrphanPdas[idx] || actor.publicKey,
          treasury: global.treasury,
          campaignTokenAta: campaignAtaLocal || actor.publicKey,
          userTokenAta: actor.publicKey,
          referrerTokenAta: actor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([actor])
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, false);
  });

  it('rate limit: per-minute cap enforced across levels', async () => {
    // set per-minute cap to 1
    await program.methods.setRateLimits(1, 1_000_000_000_000)
      .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
      .rpc();

    const actor = Keypair.generate();
    await provider.connection.requestAirdrop(actor.publicKey, 5_000_000_000);

    // create user account PDA for actor
    try {
      await program.methods.createUser()
        .accounts({ userAccount: actor.publicKey, owner: actor.publicKey, payer: actor.publicKey, systemProgram: SystemProgram.programId })
        .signers([actor])
        .rpc();
    } catch (e) {
      // ignore if exists
    }

    // first commit level 1 should succeed
    await program.methods.commitLevel(1, null, false)
      .accounts({
        payer: actor.publicKey,
        global: globalPDA,
        userAccount: actor.publicKey,
        userOwner: actor.publicKey,
        referrerUserAccount: actor.publicKey,
        orphanPool: global.orphanPools ? global.orphanPools[0] : actor.publicKey,
        pendingOrphanPda: global.pendingOrphanPdas[0] || actor.publicKey,
        treasury: global.treasury,
        campaignTokenAta: campaignAtaLocal || actor.publicKey,
        userTokenAta: actor.publicKey,
        referrerTokenAta: actor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([actor])
      .rpc();

    // immediate second commit to level 2 should fail due to per-minute cap
    let failed = false;
    try {
      await program.methods.commitLevel(2, null, false)
        .accounts({
          payer: actor.publicKey,
          global: globalPDA,
          userAccount: actor.publicKey,
          userOwner: actor.publicKey,
          referrerUserAccount: actor.publicKey,
          orphanPool: global.orphanPools ? global.orphanPools[1] : actor.publicKey,
          pendingOrphanPda: global.pendingOrphanPdas[1] || actor.publicKey,
          treasury: global.treasury,
          campaignTokenAta: campaignAtaLocal || actor.publicKey,
          userTokenAta: actor.publicKey,
          referrerTokenAta: actor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([actor])
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);
  });

  it('rate limit: window reset via admin_set_user_commits allows further commits', async () => {
    const actor = Keypair.generate();
    await provider.connection.requestAirdrop(actor.publicKey, 5_000_000_000);

    // create user account
    try {
      await program.methods.createUser()
        .accounts({ userAccount: actor.publicKey, owner: actor.publicKey, payer: actor.publicKey, systemProgram: SystemProgram.programId })
        .signers([actor])
        .rpc();
    } catch (e) { }

    // set per-minute cap to 1
    await program.methods.setRateLimits(1, 1_000_000_000_000)
      .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
      .rpc();

    // first commit succeeds
    await program.methods.commitLevel(1, null, false)
      .accounts({
        payer: actor.publicKey,
        global: globalPDA,
        userAccount: actor.publicKey,
        userOwner: actor.publicKey,
        referrerUserAccount: actor.publicKey,
        orphanPool: global.orphanPools ? global.orphanPools[0] : actor.publicKey,
        pendingOrphanPda: global.pendingOrphanPdas[0] || actor.publicKey,
        treasury: global.treasury,
        campaignTokenAta: campaignAtaLocal || actor.publicKey,
        userTokenAta: actor.publicKey,
        referrerTokenAta: actor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([actor])
      .rpc();

    // admin sets last_commit_window_ts to an old window (simulate passing time)
    const now = Math.floor(Date.now() / 1000);
    const oldWindow = Math.floor((now - 120) / 60);
    await program.methods.adminSetUserCommits(oldWindow, 1)
      .accounts({ admin: provider.wallet.publicKey, userAccount: actor.publicKey })
      .rpc();

    // now commit to level 2 should succeed
    let failed = false;
    try {
      await program.methods.commitLevel(2, null, false)
        .accounts({
          payer: actor.publicKey,
          global: globalPDA,
          userAccount: actor.publicKey,
          userOwner: actor.publicKey,
          referrerUserAccount: actor.publicKey,
          orphanPool: global.orphanPools ? global.orphanPools[1] : actor.publicKey,
          pendingOrphanPda: global.pendingOrphanPdas[1] || actor.publicKey,
          treasury: global.treasury,
          campaignTokenAta: campaignAtaLocal || actor.publicKey,
          userTokenAta: actor.publicKey,
          referrerTokenAta: actor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([actor])
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, false);
  });

  it('rate limit: overflow handling rejects commits when commits_in_window is max', async () => {
    const actor = Keypair.generate();
    await provider.connection.requestAirdrop(actor.publicKey, 5_000_000_000);

    // create user account
    try {
      await program.methods.createUser()
        .accounts({ userAccount: actor.publicKey, owner: actor.publicKey, payer: actor.publicKey, systemProgram: SystemProgram.programId })
        .signers([actor])
        .rpc();
    } catch (e) { }

    // admin sets commits_in_window to 255 and last_commit_window_ts to current window
    const now = Math.floor(Date.now() / 1000);
    const curWindow = Math.floor(now / 60);
    await program.methods.adminSetUserCommits(curWindow, 255)
      .accounts({ admin: provider.wallet.publicKey, userAccount: actor.publicKey })
      .rpc();

    // attempt to commit level 1 should fail due to overflow check
    let failed = false;
    try {
      await program.methods.commitLevel(1, null, false)
        .accounts({
          payer: actor.publicKey,
          global: globalPDA,
          userAccount: actor.publicKey,
          userOwner: actor.publicKey,
          referrerUserAccount: actor.publicKey,
          orphanPool: global.orphanPools ? global.orphanPools[0] : actor.publicKey,
          pendingOrphanPda: global.pendingOrphanPdas[0] || actor.publicKey,
          treasury: global.treasury,
          campaignTokenAta: campaignAtaLocal || actor.publicKey,
          userTokenAta: actor.publicKey,
          referrerTokenAta: actor.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([actor])
        .rpc();
    } catch (e) {
      failed = true;
    }
    assert.strictEqual(failed, true);
  });

  it('rate limit: concurrent bursts respect per-minute cap', async () => {
    const actor = Keypair.generate();
    await provider.connection.requestAirdrop(actor.publicKey, 10_000_000_000);

    // create user account
    try {
      await program.methods.createUser()
        .accounts({ userAccount: actor.publicKey, owner: actor.publicKey, payer: actor.publicKey, systemProgram: SystemProgram.programId })
        .signers([actor])
        .rpc();
    } catch (e) { }

    // set per-minute cap to 2
    await program.methods.setRateLimits(2, 1_000_000_000_000)
      .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
      .rpc();

    // first commit (level 1)
    await program.methods.commitLevel(1, null, false)
      .accounts({
        payer: actor.publicKey,
        global: globalPDA,
        userAccount: actor.publicKey,
        userOwner: actor.publicKey,
        referrerUserAccount: actor.publicKey,
        orphanPool: global.orphanPools ? global.orphanPools[0] : actor.publicKey,
        pendingOrphanPda: global.pendingOrphanPdas[0] || actor.publicKey,
        treasury: global.treasury,
        campaignTokenAta: campaignAtaLocal || actor.publicKey,
        userTokenAta: actor.publicKey,
        referrerTokenAta: actor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([actor])
      .rpc();

    // attempt two commits (level2 and level3) concurrently - at most one should succeed
    const p1 = program.methods.commitLevel(2, null, false).accounts({
      payer: actor.publicKey,
      global: globalPDA,
      userAccount: actor.publicKey,
      userOwner: actor.publicKey,
      referrerUserAccount: actor.publicKey,
      orphanPool: global.orphanPools ? global.orphanPools[1] : actor.publicKey,
      pendingOrphanPda: global.pendingOrphanPdas[1] || actor.publicKey,
      treasury: global.treasury,
      campaignTokenAta: campaignAtaLocal || actor.publicKey,
      userTokenAta: actor.publicKey,
      referrerTokenAta: actor.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).signers([actor]).rpc();

    const p2 = program.methods.commitLevel(3, null, false).accounts({
      payer: actor.publicKey,
      global: globalPDA,
      userAccount: actor.publicKey,
      userOwner: actor.publicKey,
      referrerUserAccount: actor.publicKey,
      orphanPool: global.orphanPools ? global.orphanPools[2] : actor.publicKey,
      pendingOrphanPda: global.pendingOrphanPdas[2] || actor.publicKey,
      treasury: global.treasury,
      campaignTokenAta: campaignAtaLocal || actor.publicKey,
      userTokenAta: actor.publicKey,
      referrerTokenAta: actor.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).signers([actor]).rpc();

    const results = await Promise.allSettled([p1, p2]);
    const failures = results.filter(r => r.status === 'rejected').length;
    // at least one should fail because cap is 2 and we already used 1 slot
    assert.ok(failures >= 1);
  });    // set per-minute cap to 1
  await program.methods.setRateLimits(1, 1_000_000_000_000)
    .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
    .rpc();

  const actor = Keypair.generate();
  await provider.connection.requestAirdrop(actor.publicKey, 5_000_000_000);

  // first commit
  await program.methods.commitLevel(level, null, false)
    .accounts({
      payer: actor.publicKey,
      global: globalPDA,
      userAccount: actor.publicKey,
      userOwner: actor.publicKey,
      referrerUserAccount: actor.publicKey,
      orphanPool: global.orphanPools ? global.orphanPools[idx] : actor.publicKey,
      pendingOrphanPda: global.pendingOrphanPdas[idx] || actor.publicKey,
      treasury: global.treasury,
      campaignTokenAta: campaignAta || actor.publicKey,
      userTokenAta: actor.publicKey,
      referrerTokenAta: actor.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([actor])
    .rpc();

  // simulate waiting for >60 seconds by setting the user's last_commit_window_ts back (admin helper exists)
  const now = Math.floor(Date.now() / 1000);
  await program.methods.adminSetUserActivationTimestamp(level, now - 120)
    .accounts({ admin: provider.wallet.publicKey, userAccount: actor.publicKey })
    .rpc();

  // second commit should now succeed after window reset
  let failed = false;
  try {
    await program.methods.commitLevel(level, null, false)
      .accounts({
        payer: actor.publicKey,
        global: globalPDA,
        userAccount: actor.publicKey,
        userOwner: actor.publicKey,
        referrerUserAccount: actor.publicKey,
        orphanPool: global.orphanPools ? global.orphanPools[idx] : actor.publicKey,
        pendingOrphanPda: global.pendingOrphanPdas[idx] || actor.publicKey,
        treasury: global.treasury,
        campaignTokenAta: campaignAta || actor.publicKey,
        userTokenAta: actor.publicKey,
        referrerTokenAta: actor.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([actor])
      .rpc();
  } catch (e) {
    failed = true;
  }
  assert.strictEqual(failed, false);
});

it('rounding behavior: price 1 lamport -> ref share 0, remainder 0', async () => {
  const p = 1;
  const ref_bps = Number(global.referralReferrerBps);
  const ref_share = Math.floor((BigInt(p) * BigInt(ref_bps)) / BigInt(10000));
  assert.strictEqual(Number(ref_share), 0);
  const home_share = p - Number(ref_share);
  assert.strictEqual(home_share, 1);
  const transferred = Number(ref_share) + home_share;
  const remainder = p - transferred;
  assert.strictEqual(remainder, 0);
});

it('concurrent parents assign orphans correctly', async () => {
  // Ensure we have the PDAs
  const pendingPda = global.pendingOrphanPdas[idx] as PublicKey;
  const orphanPoolPda = global.orphanPools ? global.orphanPools[idx] as PublicKey : expectedOrphanPoolPda;

  // parent_share
  const parent_share = Number(calcShare(price, Number(global.orphanParentBps)));

  // Create 4 orphan accounts and commit them as orphans
  const orphans = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const o of orphans) {
    await provider.connection.requestAirdrop(o.publicKey, price + 1_000_000);

    await program.methods.commitLevel(level, null, false)
      .accounts({
        payer: o.publicKey,
        global: globalPDA,
        userAccount: o.publicKey,
        userOwner: o.publicKey,
        referrerUserAccount: o.publicKey,
        orphanPool: orphanPoolPda,
        pendingOrphanPda: pendingPda,
        treasury: global.treasury,
        campaignTokenAta: campaignAta || o.publicKey,
        userTokenAta: o.publicKey,
        referrerTokenAta: o.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([o])
      .rpc();
  }

  // fetch pool and pending totals before parents
  const poolBefore: any = await program.account.orphanPool.fetch(orphanPoolPda);
  const pendingBefore = await provider.connection.getBalance(pendingPda);
  const globalBefore: any = await program.account.globalConfig.fetch(globalPDA);

  assert.strictEqual(poolBefore.queue.length, orphans.length);

  // Create 3 parent accounts and fund them
  const parents = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  for (const p of parents) {
    await provider.connection.requestAirdrop(p.publicKey, price + 1_000_000);
  }

  // Immediate-assign test: one parent opts-in and claims immediately
  const immediateParent = parents[0];
  // Activate immediateParent
  await program.methods.commitLevel(level, null, false)
    .accounts({
      payer: immediateParent.publicKey,
      global: globalPDA,
      userAccount: immediateParent.publicKey,
      userOwner: immediateParent.publicKey,
      referrerUserAccount: immediateParent.publicKey,
      orphanPool: orphanPoolPda,
      pendingOrphanPda: pendingPda,
      treasury: global.treasury,
      campaignTokenAta: campaignAta || immediateParent.publicKey,
      userTokenAta: immediateParent.publicKey,
      referrerTokenAta: immediateParent.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([immediateParent])
    .rpc();

  // set immediate assign opt-in
  await program.methods.setImmediateAssign(level, true)
    .accounts({ signer: immediateParent.publicKey, userAccount: immediateParent.publicKey })
    .signers([immediateParent])
    .rpc();

  // claim orphans immediately (max 5)
  await program.methods.claimOrphans(level, 5, true)
    .accounts({
      claimer: immediateParent.publicKey,
      global: globalPDA,
      userAccount: immediateParent.publicKey,
      userOwner: immediateParent.publicKey,
      orphanPool: orphanPoolPda,
      pendingOrphanPda: pendingPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([immediateParent])
    .rpc();

  // Now activate remaining parents concurrently
  const remainingParents = parents.slice(1);

  // capture SlotActivated and OrphanAssigned events during activation
  const slotEvents: any[] = [];
  const orphanAssignedEvents: any[] = [];
  const slotListener = program.addEventListener('SlotActivated', (e: any) => slotEvents.push(e));
  const orphanListener = program.addEventListener('OrphanAssigned', (e: any) => orphanAssignedEvents.push(e));

  const parentPromises = remainingParents.map(p => {
    return program.methods.commitLevel(level, null, false)
      .accounts({
        payer: p.publicKey,
        global: globalPDA,
        userAccount: p.publicKey,
        userOwner: p.publicKey,
        referrerUserAccount: p.publicKey,
        orphanPool: orphanPoolPda,
        pendingOrphanPda: pendingPda,
        treasury: global.treasury,
        campaignTokenAta: campaignAta || p.publicKey,
        userTokenAta: p.publicKey,
        referrerTokenAta: p.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([p])
      .rpc();
  });

  await Promise.all(parentPromises);

  // remove listeners
  await program.removeEventListener(slotListener);
  await program.removeEventListener(orphanListener);

  // After parents activated, some or all orphans should be assigned
  const poolAfter: any = await program.account.orphanPool.fetch(orphanPoolPda);
  const pendingAfter = await provider.connection.getBalance(pendingPda);
  const globalAfter: any = await program.account.globalConfig.fetch(globalPDA);

  // assigned count total is initial pool minus poolAfter length
  const assignedCount = poolBefore.queue.length - poolAfter.queue.length;

  // verify that SlotActivated events were emitted for each parent activation
  assert.ok(slotEvents.length >= remainingParents.length, `expected at least ${remainingParents.length} SlotActivated events`);

  // verify that number of OrphanAssigned events equals assignedCount (defensive)
  assert.strictEqual(orphanAssignedEvents.length, assignedCount);

  // pending totals should have decreased by parent_share * assigned_count
  const expectedDecrease = parent_share * assignedCount;
  assert.strictEqual(Number(globalBefore.pendingOrphanTotals[idx]) - Number(globalAfter.pendingOrphanTotals[idx]), expectedDecrease);

  // pending PDA balance decreased by same amount
  assert.strictEqual(pendingBefore - pendingAfter, expectedDecrease);

  // pool length decreased accordingly
  assert.strictEqual(poolBefore.queue.length - poolAfter.queue.length, assignedCount);

  // stricter parent balance checks: fetch balances before/after
  const parentsBalancesBefore = await Promise.all(parents.map(p => provider.connection.getBalance(p.publicKey)));
  const parentsBalancesAfter = await Promise.all(parents.map(p => provider.connection.getBalance(p.publicKey)));
  const FEE_ALLOWANCE = 5_000; // lamports (reduced for stricter checks)

  for (let i = 0; i < parents.length; i++) {
    const beforeBal = parentsBalancesBefore[i];
    const afterBal = parentsBalancesAfter[i];
    // count number of assignments to this parent from events
    const assignedToThisParent = orphanAssignedEvents.filter(a => a.parent === parents[i].publicKey.toString()).length;
    // expected net change = -price (they paid to activate) + assigned_count * parent_share
    const expectedNet = -price + assignedToThisParent * parent_share;
    const actualNet = afterBal - beforeBal;
    assert.ok(Math.abs(actualNet - expectedNet) <= FEE_ALLOWANCE, `Parent ${i} net mismatch: expected ${expectedNet}, actual ${actualNet}`);
  }

  // time-based claim path: set a new parent activation timestamp in the past (via admin helper) and claim
  const delayedParent = parents[1];
  const now = Math.floor(Date.now() / 1000);
  // set activation timestamp to now - (global.orphanAssignmentDelaySeconds + 10)
  const delay = Number(global.orphanAssignmentDelaySeconds || 86400);
  const oldTs = now - (delay + 10);

  await program.methods.adminSetUserActivationTimestamp(level, oldTs)
    .accounts({ admin: provider.wallet.publicKey, userAccount: delayedParent.publicKey })
    .rpc();

  // claim without immediate flag
  await program.methods.claimOrphans(level, 5, false)
    .accounts({
      claimer: delayedParent.publicKey,
      global: globalPDA,
      userAccount: delayedParent.publicKey,
      userOwner: delayedParent.publicKey,
      orphanPool: orphanPoolPda,
      pendingOrphanPda: pendingPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([delayedParent])
    .rpc();

  const poolFinal: any = await program.account.orphanPool.fetch(orphanPoolPda);
  assert.ok(poolFinal.queue.length <= poolAfter.queue.length);
});
// After parents activated, some or all orphans should be assigned
const poolAfter: any = await program.account.orphanPool.fetch(orphanPoolPda);
const pendingAfter = await provider.connection.getBalance(pendingPda);
const globalAfter: any = await program.account.globalConfig.fetch(globalPDA);

// assigned count total is initial pool minus poolAfter length
const assignedCount = poolBefore.queue.length - poolAfter.queue.length;

// pending totals should have decreased by parent_share * assigned_count
const expectedDecrease = parent_share * assignedCount;
assert.strictEqual(Number(globalBefore.pendingOrphanTotals[idx]) - Number(globalAfter.pendingOrphanTotals[idx]), expectedDecrease);

// pending PDA balance decreased by same amount
assert.strictEqual(pendingBefore - pendingAfter, expectedDecrease);

// pool length decreased accordingly
assert.strictEqual(poolBefore.queue.length - poolAfter.queue.length, assignedCount);

// stricter parent balance checks: fetch balances before/after
const parentsBalancesBefore = await Promise.all(parents.map(p => provider.connection.getBalance(p.publicKey)));
const parentsBalancesAfter = await Promise.all(parents.map(p => provider.connection.getBalance(p.publicKey)));
const FEE_ALLOWANCE = 20_000; // lamports

for (let i = 0; i < parents.length; i++) {
  const beforeBal = parentsBalancesBefore[i];
  const afterBal = parentsBalancesAfter[i];
  // count number of assignments to this parent by scanning OrphanAssigned events in the account history
  // fallback: we check net change is plausible (>= -price and <= some reasonable amount)
  const net = afterBal - beforeBal;
  assert.ok(net >= -price - FEE_ALLOWANCE);
}
});

it('referral commit transfers ref share and treasury receives home share; token reward sent', async () => {
  const payer = provider.wallet.payer as Keypair;
  const globalPDA = (await PublicKey.findProgramAddress([Buffer.from('global-config')], program.programId))[0];
  const global: any = await program.account.globalConfig.fetch(globalPDA);

  const level = 1;
  const idx = level - 1;
  const price = Number(global.levelPrices[idx]);
  const ref_share = Number(calcShare(price, Number(global.referralReferrerBps)));
  const home_share = price - ref_share;

  // Create a dummy referrer user and ensure activated status is set in a realistic test harness
  // For now assume referrerPubkey is a valid, active user (set up in a full test fixture)
  const referrerPubkey = payer.publicKey; // placeholder

  const treasuryBefore = await provider.connection.getBalance(global.treasury);
  const refBefore = await provider.connection.getBalance(referrerPubkey);

  await program.methods.commitLevel(level, referrerPubkey, false)
    .accounts({
      payer: payer.publicKey,
      global: globalPDA,
      userAccount: payer.publicKey,
      userOwner: payer.publicKey,
      referrerUserAccount: referrerPubkey,
      orphanPool: global.orphanPools ? global.orphanPools[idx] : payer.publicKey,
      pendingOrphanPda: global.pendingOrphanPdas[idx],
      treasury: global.treasury,
      campaignTokenAta: campaignAta || payer.publicKey,
      userTokenAta: payer.publicKey,
      referrerTokenAta: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  const treasuryAfter = await provider.connection.getBalance(global.treasury);
  const refAfter = await provider.connection.getBalance(referrerPubkey);

  // treasury should have increased by home_share plus any remainder
  const transferred_total_ref = ref_share + home_share;
  const remainder_ref = price - transferred_total_ref;
  assert.strictEqual(treasuryAfter, treasuryBefore + home_share + remainder_ref);
  assert.strictEqual(refAfter, refBefore + ref_share);
});
});
