import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { GrowRewards } from "../target/types/grow_rewards";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { assert, expect } from "chai";

describe("Grow Rewards: Make Your First Move - Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GrowRewards as Program<GrowRewards>;

  const admin = Keypair.generate();
  const verifier = Keypair.generate();
  const alice = Keypair.generate();
  const bob = Keypair.generate();
  const eveSybil = Keypair.generate();

  let rewardMint: PublicKey;
  let adminAta: PublicKey;
  let aliceAta: PublicKey;
  let bobAta: PublicKey;

  const campaignId = new anchor.BN(9001);
  const baseReward = new anchor.BN(50_000_000); // 50 tokens (6 decimals)
  const maxClaimants = 2; // Strict cap of 2 for testing
  const decayPeriodSlots = new anchor.BN(100);

  let campaignPda: PublicKey;
  let rewardVaultPda: PublicKey;

  before(async () => {
    // Airdrop SOL to participants
    for (const kp of [admin, verifier, alice, bob, eveSybil]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
    }

    // Create Reward Mint
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // Create Associated Token Accounts
    adminAta = await createAssociatedTokenAccount(
      provider.connection,
      admin,
      rewardMint,
      admin.publicKey
    );

    aliceAta = await createAssociatedTokenAccount(
      provider.connection,
      alice,
      rewardMint,
      alice.publicKey
    );

    bobAta = await createAssociatedTokenAccount(
      provider.connection,
      bob,
      rewardMint,
      bob.publicKey
    );

    // Mint supply to Admin
    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      adminAta,
      admin.publicKey,
      1_000_000_000
    );

    // Derive PDAs
    [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("grow_campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [rewardVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  });

  it("1. Successfully initializes a 'Make Your First Move' Campaign", async () => {
    await program.methods
      .initializeCampaign(
        campaignId,
        baseReward,
        maxClaimants,
        verifier.publicKey,
        decayPeriodSlots
      )
      .accounts({
        admin: admin.publicKey,
        rewardMint: rewardMint,
        campaign: campaignPda,
        rewardVault: rewardVaultPda,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    // Fund the campaign vault
    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      rewardVaultPda,
      admin.publicKey,
      500_000_000
    );

    const campaignState = await program.account.campaign.fetch(campaignPda);
    assert.equal(campaignState.campaignId.toNumber(), 9001);
    assert.equal(campaignState.claimantsCount, 0);
    assert.equal(campaignState.maxClaimants, 2);
    assert.isFalse(campaignState.isPaused);
  });

  it("2. User Alice executes First Move: Receives Base Reward + Early Mover Multiplier", async () => {
    const [aliceTracker] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_tracker"),
        campaignId.toArrayLike(Buffer, "le", 8),
        alice.publicKey.toBuffer(),
      ],
      program.programId
    );

    const timestamp = Math.floor(Date.now() / 1000);
    const signatureDummy = new Array(64).fill(1);

    await program.methods
      .claimFirstMove(signatureDummy, new anchor.BN(timestamp))
      .accounts({
        user: alice.publicKey,
        verifierAuthority: verifier.publicKey,
        campaign: campaignPda,
        userTracker: aliceTracker,
        rewardVault: rewardVaultPda,
        userRewardAccount: aliceAta,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([alice, verifier])
      .rpc();

    const aliceTokenAccount = await getAccount(provider.connection, aliceAta);
    // Multiplier is ~25000 bps (2.5x baseReward = 125,000,000)
    assert.isTrue(Number(aliceTokenAccount.amount) >= 50_000_000);

    const tracker = await program.account.userTracker.fetch(aliceTracker);
    assert.isTrue(tracker.has_claimed);
    assert.equal(tracker.user.toBase58(), alice.publicKey.toBase58());
  });

  it("3. Sybil Defense: Alice cannot double-claim First Move", async () => {
    const [aliceTracker] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_tracker"),
        campaignId.toArrayLike(Buffer, "le", 8),
        alice.publicKey.toBuffer(),
      ],
      program.programId
    );

    const timestamp = Math.floor(Date.now() / 1000);
    const signatureDummy = new Array(64).fill(1);

    try {
      await program.methods
        .claimFirstMove(signatureDummy, new anchor.BN(timestamp))
        .accounts({
          user: alice.publicKey,
          verifierAuthority: verifier.publicKey,
          campaign: campaignPda,
          userTracker: aliceTracker,
          rewardVault: rewardVaultPda,
          userRewardAccount: aliceAta,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([alice, verifier])
        .rpc();
      assert.fail("Should have thrown error on double claim");
    } catch (err: any) {
      expect(err.toString()).to.include("custom program error");
    }
  });

  it("4. Unauthorized Verifier signature is rejected", async () => {
    const [bobTracker] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_tracker"),
        campaignId.toArrayLike(Buffer, "le", 8),
        bob.publicKey.toBuffer(),
      ],
      program.programId
    );

    const fakeVerifier = Keypair.generate();
    const timestamp = Math.floor(Date.now() / 1000);
    const signatureDummy = new Array(64).fill(1);

    try {
      await program.methods
        .claimFirstMove(signatureDummy, new anchor.BN(timestamp))
        .accounts({
          user: bob.publicKey,
          verifierAuthority: fakeVerifier.publicKey,
          campaign: campaignPda,
          userTracker: bobTracker,
          rewardVault: rewardVaultPda,
          userRewardAccount: bobAta,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([bob, fakeVerifier])
        .rpc();
      assert.fail("Should have thrown UnauthorizedVerifier");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedVerifier");
    }
  });

  it("5. Strict Cap Enforcement: Reaching max claimants halts further claims", async () => {
    // Bob claims successfully (Claimant #2)
    const [bobTracker] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_tracker"),
        campaignId.toArrayLike(Buffer, "le", 8),
        bob.publicKey.toBuffer(),
      ],
      program.programId
    );

    const timestamp = Math.floor(Date.now() / 1000);
    const signatureDummy = new Array(64).fill(1);

    await program.methods
      .claimFirstMove(signatureDummy, new anchor.BN(timestamp))
      .accounts({
        user: bob.publicKey,
        verifierAuthority: verifier.publicKey,
        campaign: campaignPda,
        userTracker: bobTracker,
        rewardVault: rewardVaultPda,
        userRewardAccount: bobAta,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      })
      .signers([bob, verifier])
      .rpc();

    // Eve (Claimant #3) attempts claim, fails due to max_claimants = 2
    const [eveTracker] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_tracker"),
        campaignId.toArrayLike(Buffer, "le", 8),
        eveSybil.publicKey.toBuffer(),
      ],
      program.programId
    );

    const eveAta = await createAssociatedTokenAccount(
      provider.connection,
      eveSybil,
      rewardMint,
      eveSybil.publicKey
    );

    try {
      await program.methods
        .claimFirstMove(signatureDummy, new anchor.BN(timestamp))
        .accounts({
          user: eveSybil.publicKey,
          verifierAuthority: verifier.publicKey,
          campaign: campaignPda,
          userTracker: eveTracker,
          rewardVault: rewardVaultPda,
          userRewardAccount: eveAta,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([eveSybil, verifier])
        .rpc();
      assert.fail("Should have thrown CampaignCapReached");
    } catch (err: any) {
      expect(err.toString()).to.include("CampaignCapReached");
    }
  });
});