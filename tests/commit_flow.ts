import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { Keypair, SystemProgram, PublicKey } from "@solana/web3.js";

describe("coco-staking - commit flow tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CocoStaking as Program;

  it("initialize global and perform referral commit", async () => {
    // initialize global
    const globalPda = await PublicKey.findProgramAddress([Buffer.from("global-config")], program.programId);

    await program.rpc.initializeGlobal(
      DEFAULT_LEVEL_PRICES,
      DEFAULT_COCO_REWARDS,
      DEFAULT_REFERRER_BPS,
      DEFAULT_ORPHAN_PARENT_BPS,
      DEFAULT_SLOT_COUNT,
      {
        accounts: {
          global: globalPda[0],
          payer: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        },
      }
    );

    // create referrer user (different owner)
    const refOwner = Keypair.generate();
    // airdrop to owner so payer can sign transactions later if needed
    await provider.connection.requestAirdrop(refOwner.publicKey, 1_000_000_000);

    const referrerPda = (await PublicKey.findProgramAddress([Buffer.from("user"), refOwner.publicKey.toBuffer()], program.programId))[0];

    await program.rpc.createUser({
      accounts: {
        userAccount: referrerPda,
        owner: refOwner.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
    });

    // activate level 1 for referrer (they will be orphan in this simple test)
    await program.rpc.commitLevel(new anchor.BN(1), null, false, {
      accounts: {
        payer: refOwner.publicKey,
        global: globalPda[0],
        userAccount: referrerPda,
        referrerUserAccount: provider.wallet.publicKey, // dummy
        orphanPool: provider.wallet.publicKey,
        pendingOrphanPda: provider.wallet.publicKey,
        treasury: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
      signers: [refOwner],
    });

    // create main user
    const userOwner = provider.wallet.publicKey;
    const userPda = (await PublicKey.findProgramAddress([Buffer.from("user"), userOwner.toBuffer()], program.programId))[0];

    await program.rpc.createUser({
      accounts: {
        userAccount: userPda,
        owner: userOwner,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
    });

    // create orphan user
    const orphanOwner = Keypair.generate();
    await provider.connection.requestAirdrop(orphanOwner.publicKey, 1_000_000_000);
    const [orphanPda] = await PublicKey.findProgramAddress([Buffer.from("user"), orphanOwner.publicKey.toBuffer()], program.programId);

    await program.rpc.createUser({
      accounts: {
        userAccount: orphanPda,
        owner: orphanOwner.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
      signers: [orphanOwner],
    });

    // Initialize pending orphan PDA for level 1
    const [pendingPda, pendingBump] = await PublicKey.findProgramAddress([Buffer.from("pending-orphan"), Buffer.from([1])], program.programId);
    await program.rpc.initPendingOrphan(1, {
      accounts: {
        global: globalPda,
        pendingOrphanPda: pendingPda,
        admin: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
    });

    // orphan commit (no referrer), funds should go to pendingPda
    const beforePendingBal = await provider.connection.getBalance(pendingPda);

    await program.rpc.commitLevel(1, null, false, {
      accounts: {
        payer: orphanOwner.publicKey,
        global: globalPda,
        userAccount: orphanPda,
        userOwner: orphanOwner.publicKey,
        referrerUserAccount: provider.wallet.publicKey,
        orphanPool: provider.wallet.publicKey,
        pendingOrphanPda: pendingPda,
        treasury: provider.wallet.publicKey,
        campaignTokenAta: campaignAta.address,
        userTokenAta: orphanPda, // dummy
        referrerTokenAta: referrerAta.address,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      },
      signers: [orphanOwner],
    });

    const afterPendingBal = await provider.connection.getBalance(pendingPda);

    // parent share = 20% of 0.06 SOL = 12_000_000 lamports
    const expectedParentShare = Math.floor(60_000_000 * 2000 / 10000);
    if (afterPendingBal - beforePendingBal !== expectedParentShare) {
      throw new Error(`Pending orphan did not receive expected share: expected ${expectedParentShare}, got ${afterPendingBal - beforePendingBal}`);
    }

    // fetch balances before commit
    const beforeRefBal = await provider.connection.getBalance(referrerPda);

    // commit as referral (user -> referrer)
    await program.rpc.commitLevel(1, referrerPda, false, {
      accounts: {
        payer: provider.wallet.publicKey,
        global: globalPda[0],
        userAccount: userPda,
        referrerUserAccount: referrerPda,
        orphanPool: provider.wallet.publicKey,
        pendingOrphanPda: provider.wallet.publicKey,
        treasury: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      },
    });

    const afterRefBal = await provider.connection.getBalance(referrerPda);

    // referrer should have received the referrer share (40% of 0.06 SOL = 0.024 SOL = 24_000_000 lamports)
    const expectedRefGain = Math.floor(60_000_000 * 4000 / 10000);

    if (afterRefBal - beforeRefBal !== expectedRefGain) {
      throw new Error(`Referrer did not receive expected share: expected ${expectedRefGain}, got ${afterRefBal - beforeRefBal}`);
    }

    // check user account activated
    const userAccountState: any = await program.account.userAccount.fetch(userPda);
    if (!userAccountState.activated[0]) {
      throw new Error("User did not get level activated");
    }
  });
});
