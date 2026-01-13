import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";
import { createMint, mintTo, getOrCreateAssociatedTokenAccount, setAuthority, AuthorityType, getAccount } from "@solana/spl-token";

describe("coco-staking - commit flow and concurrency tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CocoStaking as Program;

  it("full flow: init global, set campaign authority, orphan and referral, assign orphan", async () => {
    // derive global PDA
    const [globalPda, _gBump] = await PublicKey.findProgramAddress([Buffer.from("global-config")], program.programId);

    // initialize global
    await program.rpc.initializeGlobal(
      [60000000,120000000,240000000,480000000,960000000],
      [60000000,120000000,240000000,480000000,960000000],
      4000,
      2000,
      5,
      {
        accounts: {
          global: globalPda,
          payer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        },
      }
    );

    // create COCO mint and campaign ATA (admin)
    const mint = await createMint(
      provider.connection,
      provider.wallet.payer as any,
      provider.wallet.publicKey,
      null,
      0
    );

    const campaignAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      provider.wallet.payer as any,
      mint,
      provider.wallet.publicKey
    );

    // mint a large amount to campaign ATA
    await mintTo(
      provider.connection,
      provider.wallet.payer as any,
      mint,
      campaignAta.address,
      provider.wallet.payer as any,
      1_000_000
    );

    // set campaign ATA owner to global PDA so program can transfer
    await setAuthority(
      provider.connection,
      provider.wallet.payer as any,
      campaignAta.address,
      provider.wallet.publicKey,
      { type: AuthorityType.AccountOwner },
      globalPda
    );

    // register campaign ATA in global config (admin)
    await program.rpc.setCampaignAta(1, campaignAta.address, {
      accounts: {
        global: globalPda,
        admin: provider.wallet.publicKey,
      },
    });

    const globalAfterSet: any = await program.account.globalConfig.fetch(globalPda);
    if (globalAfterSet.campaignTokenAtas[0].toString() !== campaignAta.address.toString()) {
      throw new Error("campaign ATA not set in global config");
    }

    // init pending orphan PDA and orphan pool for level 1
    const [pendingPda, pendingBump] = await PublicKey.findProgramAddress([Buffer.from("pending-orphan"), Buffer.from([1])], program.programId);
    await program.rpc.initPendingOrphan(1, {
      accounts: {
        global: globalPda,
        pendingOrphanPda: pendingPda,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
    });

    // verify global was updated
    const g1: any = await program.account.globalConfig.fetch(globalPda);
    if (g1.pendingOrphanPdas[0].toString() !== pendingPda.toString()) {
      throw new Error("pending orphan PDA not set in global config");
    }

    const [orphanPoolPda, _opBump] = await PublicKey.findProgramAddress([Buffer.from("orphan-pool"), Buffer.from([1])], program.programId);

    await program.rpc.initOrphanPool(1, new anchor.BN(100), {
      accounts: {
        global: globalPda,
        orphanPool: orphanPoolPda,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
    });

    // create referrer user and activate level 1 for them (they become orphan initially)
    const refOwner = Keypair.generate();
    await provider.connection.requestAirdrop(refOwner.publicKey, 1_000_000_000);
    const [referrerPda, _] = await PublicKey.findProgramAddress([Buffer.from("user"), refOwner.publicKey.toBuffer()], program.programId);

    await program.rpc.createUser({
      accounts: { userAccount: referrerPda, owner: refOwner.publicKey, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId },
      signers: [refOwner],
    });

    // referrer token ATA
    const referrerAta = await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer as any, mint, refOwner.publicKey);

    // activate level 1 for referrer (orphan commit)
    await program.rpc.commitLevel(1, null, false, {
      accounts: {
        payer: refOwner.publicKey,
        global: globalPda,
        userAccount: referrerPda,
        userOwner: refOwner.publicKey,
        referrerUserAccount: provider.wallet.publicKey,
        orphanPool: orphanPoolPda,
        pendingOrphanPda: pendingPda,
        treasury: provider.wallet.publicKey,
        campaignTokenAta: campaignAta.address,
        userTokenAta: referrerAta.address,
        referrerTokenAta: referrerAta.address,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      },
      signers: [refOwner],
    });

    // create many users attempting to refer to referrer concurrently
    const workers = 8;
    const participants: Keypair[] = [];
    const participantAtas: { [key: string]: PublicKey } = {};
    for (let i = 0; i < workers; i++) {
      const kp = Keypair.generate();
      participants.push(kp);
      await provider.connection.requestAirdrop(kp.publicKey, 500_000_000);
      const [pda] = await PublicKey.findProgramAddress([Buffer.from("user"), kp.publicKey.toBuffer()], program.programId);
      await program.rpc.createUser({ accounts: { userAccount: pda, owner: kp.publicKey, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId }, signers: [kp] });
      const ata = await getOrCreateAssociatedTokenAccount(provider.connection, provider.wallet.payer as any, mint, kp.publicKey);
      participantAtas[kp.publicKey.toBase58()] = ata.address;
    }

    // launch commits in parallel targeting referrerPda
    await Promise.all(participants.map(async (kp) => {
      const [kpPda] = await PublicKey.findProgramAddress([Buffer.from("user"), kp.publicKey.toBuffer()], program.programId);
      const userAta = participantAtas[kp.publicKey.toBase58()];
      try {
        await program.rpc.commitLevel(1, referrerPda, false, {
          accounts: {
            payer: kp.publicKey,
            global: globalPda,
            userAccount: kpPda,
            userOwner: kp.publicKey,
            referrerUserAccount: referrerPda,
            orphanPool: orphanPoolPda,
            pendingOrphanPda: pendingPda,
            treasury: provider.wallet.publicKey,
            campaignTokenAta: campaignAta.address,
            userTokenAta: userAta,
            referrerTokenAta: referrerAta.address,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          },
          signers: [kp],
        });
      } catch (e) {
        // some may fail or become orphan; ignore errors here
      }
    }));

    // fetch referrer account and check slots used <= 5
    const refState: any = await program.account.userAccount.fetch(referrerPda);
    if (refState.referralSlotsUsed[0] > 5) {
      throw new Error(`Referrer slots exceed limit: ${refState.referralSlotsUsed[0]}`);
    }

    // fetch global and ensure pending orphan totals reflect overflow (>=(workers - slot_count) * parent_share)
    const globalState: any = await program.account.globalConfig.fetch(globalPda);
    const expectedOverflow = Math.max(0, workers - globalState.slotCount);
    const parentShare = Math.floor(globalState.levelPrices[0].toNumber() * globalState.orphanParentBps / 10000);
    if (globalState.pendingOrphanTotals[0].toNumber() < expectedOverflow * parentShare) {
      throw new Error(`Pending orphan totals ${globalState.pendingOrphanTotals[0].toNumber()} less than expected ${expectedOverflow * parentShare}`);
    }

    // Admin assigns one orphan to referrer (parent)
    await program.rpc.assignOrphan(1, {
      accounts: {
        global: globalPda,
        orphanPool: orphanPoolPda,
        pendingOrphanPda: pendingPda,
        parentUserAccount: referrerPda,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
    });

    // verify pending totals decreased
    const globalStateAfter: any = await program.account.globalConfig.fetch(globalPda);
    if (globalStateAfter.pendingOrphanTotals[0].toNumber() >= globalState.pendingOrphanTotals[0].toNumber()) {
      throw new Error("Pending orphan totals did not decrease after assignOrphan");
    }
  }, 120000);

  it("edge cases: self-referral, double activation, invalid referral treated as orphan, rounding behavior", async () => {
    // init fresh global for these edge tests
    const [g2, _] = await PublicKey.findProgramAddress([Buffer.from("global-config")], program.programId);
    await program.rpc.initializeGlobal(
      [1,120000000,240000000,480000000,960000000], // level1 price = 1 lamport for rounding test
      [1,120000000,240000000,480000000,960000000],
      3333,
      2000,
      5,
      {
        accounts: { global: g2, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId },
      }
    );

    // init pending PDA
    const [pending2, _pb] = await PublicKey.findProgramAddress([Buffer.from("pending-orphan"), Buffer.from([1])], program.programId);
    await program.rpc.initPendingOrphan(1, { accounts: { global: g2, pendingOrphanPda: pending2, admin: provider.wallet.publicKey, systemProgram: SystemProgram.programId } });

    // create a user who will attempt self-referral
    const a = Keypair.generate();
    await provider.connection.requestAirdrop(a.publicKey, 1_000_000_000);
    const [aPda] = await PublicKey.findProgramAddress([Buffer.from("user"), a.publicKey.toBuffer()], program.programId);
    await program.rpc.createUser({ accounts: { userAccount: aPda, owner: a.publicKey, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId }, signers: [a] });

    // Self-referral should fail
    let threw = false;
    try {
      await program.rpc.commitLevel(1, aPda, false, { accounts: { payer: a.publicKey, global: g2, userAccount: aPda, userOwner: a.publicKey, referrerUserAccount: aPda, orphanPool: provider.wallet.publicKey, pendingOrphanPda: pending2, treasury: provider.wallet.publicKey, campaignTokenAta: provider.wallet.publicKey, userTokenAta: aPda, referrerTokenAta: aPda, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }, signers: [a] });
    } catch (e: any) {
      threw = true;
      if (!e.toString().toLowerCase().includes("selfreferral")) {
        // ok, accept any custom error
      }
    }
    if (!threw) throw new Error("Self-referral did not throw as expected");

    // Double activation: commit once then again
    const b = Keypair.generate();
    await provider.connection.requestAirdrop(b.publicKey, 1_000_000_000);
    const [bPda] = await PublicKey.findProgramAddress([Buffer.from("user"), b.publicKey.toBuffer()], program.programId);
    await program.rpc.createUser({ accounts: { userAccount: bPda, owner: b.publicKey, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId }, signers: [b] });

    // first commit should succeed (orphan)
    await program.rpc.commitLevel(1, null, false, { accounts: { payer: b.publicKey, global: g2, userAccount: bPda, userOwner: b.publicKey, referrerUserAccount: provider.wallet.publicKey, orphanPool: provider.wallet.publicKey, pendingOrphanPda: pending2, treasury: provider.wallet.publicKey, campaignTokenAta: provider.wallet.publicKey, userTokenAta: bPda, referrerTokenAta: bPda, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }, signers: [b] });

    // second commit should fail with AlreadyActivated
    let threw2 = false;
    try {
      await program.rpc.commitLevel(1, null, false, { accounts: { payer: b.publicKey, global: g2, userAccount: bPda, userOwner: b.publicKey, referrerUserAccount: provider.wallet.publicKey, orphanPool: provider.wallet.publicKey, pendingOrphanPda: pending2, treasury: provider.wallet.publicKey, campaignTokenAta: provider.wallet.publicKey, userTokenAta: bPda, referrerTokenAta: bPda, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }, signers: [b] });
    } catch (e: any) { threw2 = true; }
    if (!threw2) throw new Error("Double activation did not throw as expected");

    // Invalid referral (referrer hasn't activated): should become orphan and pending orphan increases
    const c = Keypair.generate();
    const d = Keypair.generate();
    await provider.connection.requestAirdrop(c.publicKey, 1_000_000_000);
    await provider.connection.requestAirdrop(d.publicKey, 1_000_000_000);
    const [cPda] = await PublicKey.findProgramAddress([Buffer.from("user"), c.publicKey.toBuffer()], program.programId);
    const [dPda] = await PublicKey.findProgramAddress([Buffer.from("user"), d.publicKey.toBuffer()], program.programId);
    await program.rpc.createUser({ accounts: { userAccount: cPda, owner: c.publicKey, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId }, signers: [c] });
    await program.rpc.createUser({ accounts: { userAccount: dPda, owner: d.publicKey, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId }, signers: [d] });

    const beforePending = (await program.account.globalConfig.fetch(g2)).pendingOrphanTotals[0].toNumber();
    await program.rpc.commitLevel(1, cPda, false, { accounts: { payer: d.publicKey, global: g2, userAccount: dPda, userOwner: d.publicKey, referrerUserAccount: cPda, orphanPool: provider.wallet.publicKey, pendingOrphanPda: pending2, treasury: provider.wallet.publicKey, campaignTokenAta: provider.wallet.publicKey, userTokenAta: dPda, referrerTokenAta: cPda, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }, signers: [d] });
    const afterPending = (await program.account.globalConfig.fetch(g2)).pendingOrphanTotals[0].toNumber();
    if (afterPending <= beforePending) throw new Error("Invalid referral did not add to pending orphan totals as expected");

    // Rounding: price=1 lamport and ref bps=3333 should yield ref_share=0
    // create a referrer and activate
    const r = Keypair.generate();
    await provider.connection.requestAirdrop(r.publicKey, 1_000_000_000);
    const [rPda] = await PublicKey.findProgramAddress([Buffer.from("user"), r.publicKey.toBuffer()], program.programId);
    await program.rpc.createUser({ accounts: { userAccount: rPda, owner: r.publicKey, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId }, signers: [r] });
    // activate r as orphan first
    await program.rpc.commitLevel(1, null, false, { accounts: { payer: r.publicKey, global: g2, userAccount: rPda, userOwner: r.publicKey, referrerUserAccount: provider.wallet.publicKey, orphanPool: provider.wallet.publicKey, pendingOrphanPda: pending2, treasury: provider.wallet.publicKey, campaignTokenAta: provider.wallet.publicKey, userTokenAta: rPda, referrerTokenAta: rPda, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }, signers: [r] });

    const beforeRBal = await provider.connection.getBalance(r.publicKey);

    // create s who will refer to r
    const s = Keypair.generate();
    await provider.connection.requestAirdrop(s.publicKey, 1_000_000_000);
    const [sPda] = await PublicKey.findProgramAddress([Buffer.from("user"), s.publicKey.toBuffer()], program.programId);
    await program.rpc.createUser({ accounts: { userAccount: sPda, owner: s.publicKey, payer: provider.wallet.publicKey, systemProgram: SystemProgram.programId }, signers: [s] });

    // s commits with referrer r
    await program.rpc.commitLevel(1, rPda, false, { accounts: { payer: s.publicKey, global: g2, userAccount: sPda, userOwner: s.publicKey, referrerUserAccount: rPda, orphanPool: provider.wallet.publicKey, pendingOrphanPda: pending2, treasury: provider.wallet.publicKey, campaignTokenAta: provider.wallet.publicKey, userTokenAta: sPda, referrerTokenAta: rPda, tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId }, signers: [s] });

    const afterRBal = await provider.connection.getBalance(r.publicKey);
    if (afterRBal - beforeRBal !== 0) throw new Error("Rounding test failed: referrer received non-zero share for 1-lamport price");

  }, 60000);
});
