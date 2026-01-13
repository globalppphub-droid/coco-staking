import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, getOrCreateAssociatedTokenAccount, mintTo, setAuthority, AuthorityType, getAccount } from "@solana/spl-token";

const assert = require('assert');

describe('audit: event totals and reconciliation', () => {
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
        } catch (e) {
            const MAX_LEVELS = 3;
            const levelPrices = new Array(MAX_LEVELS).fill(1_000_000);
            const cocoRewards = new Array(MAX_LEVELS).fill(10);
            await program.methods.initializeGlobal(levelPrices, cocoRewards, 1000, 6000, 3)
                .accounts({ admin: provider.wallet.publicKey })
                .rpc();
            global = await program.account.globalConfig.fetch(globalPDA);
        }

        // ensure campaign ATA exists
        const campaignAta = global.campaignTokenAtas[idx];
        if (!campaignAta || campaignAta.equals(new PublicKey(0))) {
            const payer = provider.wallet.payer as Keypair;
            const mint = await createMint(provider.connection, payer, payer.publicKey, null, 0);
            const ata = await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, payer.publicKey);
            await mintTo(provider.connection, payer, mint, ata.address, payer.publicKey, BigInt(1000));
            await setAuthority(provider.connection, payer, ata.address, payer.publicKey, globalPDA, AuthorityType.AccountOwner);
            campaignAtaLocal = ata.address;
            try {
                await program.methods.setCampaignAta(level, campaignAtaLocal)
                    .accounts({ admin: provider.wallet.publicKey, global: globalPDA })
                    .rpc();
                global = await program.account.globalConfig.fetch(globalPDA);
            } catch (e) {
                // ignore
            }
        } else {
            campaignAtaLocal = campaignAta;
        }

        // ensure pending orphan PDA and orphan pool exist
        const expectedPendingPda = (await PublicKey.findProgramAddress([Buffer.from('pending-orphan'), Buffer.from([level])], program.programId))[0];
        if (!global.pendingOrphanPdas[idx] || global.pendingOrphanPdas[idx].equals(new PublicKey(0))) {
            try {
                await program.methods.initPendingOrphan(level)
                    .accounts({ admin: provider.wallet.publicKey, global: globalPDA, pendingOrphanPda: expectedPendingPda, systemProgram: SystemProgram.programId })
                    .rpc();
                global = await program.account.globalConfig.fetch(globalPDA);
            } catch (e) {
                // ignore
            }
        }

        const expectedOrphanPoolPda = (await PublicKey.findProgramAddress([Buffer.from('orphan-pool'), Buffer.from([level])], program.programId))[0];
        if (!global.orphanPools || !global.orphanPools[idx] || global.orphanPools[idx].equals(new PublicKey(0))) {
            try {
                await program.methods.initOrphanPool(level, 100)
                    .accounts({ admin: provider.wallet.publicKey, global: globalPDA, orphanPool: expectedOrphanPoolPda, systemProgram: SystemProgram.programId })
                    .rpc();
                global = await program.account.globalConfig.fetch(globalPDA);
            } catch (e) {
                // ignore
            }
        }

        // fund payer for local tests
        try { await provider.connection.requestAirdrop(provider.wallet.publicKey, 5_000_000_000); } catch (e) { }
    });

    it('commit events aggregate to expected total', async () => {
        const numCommits = 3;
        const commitEvents: any[] = [];
        const listener = await program.addEventListener('CommitEvent', (e: any) => commitEvents.push(e));

        const price = Number((await program.account.globalConfig.fetch(globalPDA)).levelPrices[idx]);

        // create separate payers to avoid AlreadyActivated errors
        const payers = Array.from({ length: numCommits }, () => Keypair.generate());
        for (const p of payers) {
            await provider.connection.requestAirdrop(p.publicKey, price + 1_000_000);
            await program.methods.commitLevel(level, null, false)
                .accounts({
                    payer: p.publicKey,
                    global: globalPDA,
                    userAccount: p.publicKey,
                    userOwner: p.publicKey,
                    referrerUserAccount: p.publicKey,
                    orphanPool: global.orphanPools ? global.orphanPools[idx] : p.publicKey,
                    pendingOrphanPda: global.pendingOrphanPdas[idx] || p.publicKey,
                    treasury: global.treasury,
                    campaignTokenAta: campaignAtaLocal || p.publicKey,
                    userTokenAta: p.publicKey,
                    referrerTokenAta: p.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([p])
                .rpc();
        }

        await program.removeEventListener(listener);

        const totalFromEvents = commitEvents.reduce((acc, e) => acc + Number(e.lamports), 0);
        assert.strictEqual(totalFromEvents, numCommits * price, 'sum of CommitEvent lamports should equal executed commits total');
    });

    it('orphan assignments events reconcile with pending totals and pending PDA balance', async () => {
        const parentShare = Math.floor((Number(global.levelPrices[idx]) * Number(global.orphanParentBps)) / 10000);

        const orphanPoolPda = global.orphanPools ? global.orphanPools[idx] as PublicKey : (await PublicKey.findProgramAddress([Buffer.from('orphan-pool'), Buffer.from([level])], program.programId))[0];
        const pendingPda = global.pendingOrphanPdas[idx] as PublicKey;

        // create 3 orphan accounts and commit as orphans
        const orphans = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
        for (const o of orphans) {
            await provider.connection.requestAirdrop(o.publicKey, Number(global.levelPrices[idx]) + 1_000_000);
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
                    campaignTokenAta: campaignAtaLocal || o.publicKey,
                    userTokenAta: o.publicKey,
                    referrerTokenAta: o.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                })
                .signers([o])
                .rpc();
        }

        const globalBefore: any = await program.account.globalConfig.fetch(globalPDA);
        const pendingBeforeBal = await provider.connection.getBalance(pendingPda);

        // activate a parent and immediate-assign to trigger assignments
        const parent = Keypair.generate();
        await provider.connection.requestAirdrop(parent.publicKey, Number(global.levelPrices[idx]) + 1_000_000);
        // activate (orphan commit as parent activation)
        await program.methods.commitLevel(level, null, true)
            .accounts({
                payer: parent.publicKey,
                global: globalPDA,
                userAccount: parent.publicKey,
                userOwner: parent.publicKey,
                referrerUserAccount: parent.publicKey,
                orphanPool: orphanPoolPda,
                pendingOrphanPda: pendingPda,
                treasury: global.treasury,
                campaignTokenAta: campaignAtaLocal || parent.publicKey,
                userTokenAta: parent.publicKey,
                referrerTokenAta: parent.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .signers([parent])
            .rpc();

        // capture OrphanAssigned events during claim/assign
        const assignedEvents: any[] = [];
        const assignListener = await program.addEventListener('OrphanAssigned', (e: any) => assignedEvents.push(e));

        // call claimOrphans (in case immediateAssign consumed some already; try claim max)
        try {
            await program.methods.claimOrphans(level, 10, true)
                .accounts({ claimer: parent.publicKey, global: globalPDA, userAccount: parent.publicKey, userOwner: parent.publicKey, orphanPool: orphanPoolPda, pendingOrphanPda: pendingPda, systemProgram: SystemProgram.programId })
                .signers([parent])
                .rpc();
        } catch (e) {
            // ignore
        }

        await program.removeEventListener(assignListener);

        const totalAssignedFromEvents = assignedEvents.reduce((acc, e) => acc + Number(e.amount), 0);

        const globalAfter: any = await program.account.globalConfig.fetch(globalPDA);
        const pendingAfterBal = await provider.connection.getBalance(pendingPda);

        const expectedDecrease = totalAssignedFromEvents;
        assert.strictEqual(Number(globalBefore.pendingOrphanTotals[idx]) - Number(globalAfter.pendingOrphanTotals[idx]), expectedDecrease, 'global pending totals should decrease by assigned total');
        assert.strictEqual(pendingBeforeBal - pendingAfterBal, expectedDecrease, 'pending PDA balance should decrease by assigned total');
    });

    it('split events reconcile with treasury change and referrer payouts', async () => {
        const payer = Keypair.generate();
        const ref = Keypair.generate();
        await provider.connection.requestAirdrop(payer.publicKey, 5_000_000_000);
        await provider.connection.requestAirdrop(ref.publicKey, 2_000_000_000);

        // try to create referrer user and set activation timestamp via admin helper for safety
        try { await program.methods.createUser().accounts({ userAccount: ref.publicKey }).signers([ref]).rpc(); } catch (e) { }
        try { await program.methods.adminSetUserActivationTimestamp(level, Math.floor(Date.now() / 1000) - 1000).accounts({ admin: provider.wallet.publicKey, userAccount: ref.publicKey }).rpc(); } catch (e) { }

        const globalBefore: any = await program.account.globalConfig.fetch(globalPDA);
        const treasuryBefore = await provider.connection.getBalance(globalBefore.treasury);
        const refBefore = await provider.connection.getBalance(ref.publicKey);

        const splits: any[] = [];
        const splitListener = await program.addEventListener('SplitEvent', (e: any) => splits.push(e));

        await program.methods.commitLevel(level, ref.publicKey, false)
            .accounts({
                payer: payer.publicKey,
                global: globalPDA,
                userAccount: payer.publicKey,
                userOwner: payer.publicKey,
                referrerUserAccount: ref.publicKey,
                orphanPool: global.orphanPools ? global.orphanPools[idx] : payer.publicKey,
                pendingOrphanPda: global.pendingOrphanPdas[idx] || payer.publicKey,
                treasury: global.treasury,
                campaignTokenAta: campaignAtaLocal || payer.publicKey,
                userTokenAta: payer.publicKey,
                referrerTokenAta: ref.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
            })
            .rpc();

        await program.removeEventListener(splitListener);

        assert.ok(splits.length >= 1, 'expected at least one SplitEvent');
        const se = splits[splits.length - 1];
        const price = Number(globalBefore.levelPrices[idx]);
        const ref_share = Number(se.referrer || 0);
        const home_share = Number(se.home || 0);
        const transferred = ref_share + home_share;
        const remainder = price - transferred;

        const treasuryAfter = await provider.connection.getBalance(globalBefore.treasury);
        const refAfter = await provider.connection.getBalance(ref.publicKey);

        assert.strictEqual(treasuryAfter, treasuryBefore + home_share + remainder, 'treasury should receive home share + remainder');
        assert.strictEqual(refAfter, refBefore + ref_share, 'referrer should receive referrer share');
    });

});
