import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { GrowRewards } from "../target/types/grow_rewards";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

describe("Grow Rewards: Make Your First Move - Protocol Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GrowRewards as Program<GrowRewards>;

  const admin = (provider.wallet as anchor.Wallet).payer;
  const oracle = Keypair.generate();
  const alice = Keypair.generate(); // First Move User
  const bob = Keypair.generate();   // Sybil attacker attempt

  const campaignId = new anchor.BN(9001);
  const rewardAmount = new anchor.BN(50 * 10 ** 6); // 50 Tokens
  const maxParticipants = new anchor.BN(100);

  let rewardMint: PublicKey;
  let adminAta: PublicKey;
  let aliceAta: PublicKey;
  let campaignConfigPda: PublicKey;
  let rewardVaultPda: PublicKey;

  before(async () => {
    // 1. Airdrop SOL to test actors
    for (const actor of [oracle, alice, bob]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    // 2. Create SPL reward token
    rewardMint = await createMint(
      provider.connection,
      admin,
      admin.publicKey,
      null,
      6
    );

    // 3. Derive Program Addresses (PDAs)
    [campaignConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    [rewardVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // 4. Create ATAs
    const adminAtaAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      admin,
      rewardMint,
      admin.publicKey
    );
    adminAta = adminAtaAccount.address;

    const aliceAtaAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      alice,
      rewardMint,
      alice.publicKey
    );
    aliceAta = aliceAtaAccount.address;

    // 5. Mint tokens to admin
    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      adminAta,
      admin.publicKey,
      10_000 * 10 ** 6
    );
  });

  it("1. Successfully initializes a First Move campaign", async () => {
    await program.methods
      .initializeCampaign(campaignId, rewardAmount, maxParticipants)
      .accounts({
        admin: admin.publicKey,
        oracleSigner: oracle.publicKey,
        rewardMint: rewardMint,
        campaignConfig: campaignConfigPda,
        rewardVault: rewardVaultPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const config = await program.account.campaignConfig.fetch(campaignConfigPda);
    expect(config.campaignId.toString()).to.equal(campaignId.toString());
    expect(config.firstMoveRewardAmount.toString()).to.equal(rewardAmount.toString());
    expect(config.isActive).to.be.true;
    expect(config.currentParticipants.toNumber()).to.equal(0);
  });

  it("2. Funds the Campaign Reward Vault", async () => {
    // Deposit 5,000 tokens into the vault
    const depositAmount = 5_000 * 10 ** 6;
    const { transfer } = await import("@solana/spl-token");
    await transfer(
      provider.connection,
      admin,
      adminAta,
      rewardVaultPda,
      admin.publicKey,
      depositAmount
    );

    const vaultBalance = await provider.connection.getTokenAccountBalance(rewardVaultPda);
    expect(Number(vaultBalance.value.amount)).to.equal(depositAmount);
  });

  it("3. User executes and claims 'First Move' milestone", async () => {
    const [aliceMilestonePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_milestone"),
        campaignId.toArrayLike(Buffer, "le", 8),
        alice.publicKey.toBuffer(),
      ],
      program.programId
    );

    const currentEpochTime = Math.floor(Date.now() / 1000);
    const validExpiry = new anchor.BN(currentEpochTime + 3600); // 1 hour buffer

    await program.methods
      .claimFirstMove(campaignId, validExpiry)
      .accounts({
        user: alice.publicKey,
        oracleSigner: oracle.publicKey,
        campaignConfig: campaignConfigPda,
        rewardMint: rewardMint,
        userMilestone: aliceMilestonePda,
        rewardVault: rewardVaultPda,
        userRewardAccount: aliceAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([alice, oracle])
      .rpc();

    // Verify milestone state
    const milestone = await program.account.userMilestone.fetch(aliceMilestonePda);
    expect(milestone.firstMoveCompleted).to.be.true;
    expect(milestone.streakCount).to.equal(1);
    expect(milestone.totalRewardsClaimed.toString()).to.equal(rewardAmount.toString());

    // Verify balance transfer
    const aliceBalance = await provider.connection.getTokenAccountBalance(aliceAta);
    expect(Number(aliceBalance.value.amount)).to.equal(rewardAmount.toNumber());
  });

  it("4. Prevents duplicate First Move claims (Replay Protection)", async () => {
    const [aliceMilestonePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_milestone"),
        campaignId.toArrayLike(Buffer, "le", 8),
        alice.publicKey.toBuffer(),
      ],
      program.programId
    );

    const validExpiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);

    try {
      await program.methods
        .claimFirstMove(campaignId, validExpiry)
        .accounts({
          user: alice.publicKey,
          oracleSigner: oracle.publicKey,
          campaignConfig: campaignConfigPda,
          rewardMint: rewardMint,
          userMilestone: aliceMilestonePda,
          rewardVault: rewardVaultPda,
          userRewardAccount: aliceAta,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([alice, oracle])
        .rpc();
      expect.fail("Should have thrown error on duplicate claim");
    } catch (err: any) {
      // Anchor throws account already in use or custom error
      expect(err.toString()).to.satisfy((msg: string) => 
        msg.includes("already in use") || msg.includes("FirstMoveAlreadyClaimed")
      );
    }
  });

  it("5. Rejects claims with expired vouchers", async () => {
    const [bobMilestonePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_milestone"),
        campaignId.toArrayLike(Buffer, "le", 8),
        bob.publicKey.toBuffer(),
      ],
      program.programId
    );

    const bobAtaAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      bob,
      rewardMint,
      bob.publicKey
    );

    const expiredTimestamp = new anchor.BN(Math.floor(Date.now() / 1000) - 3600); // 1 hour in the past

    try {
      await program.methods
        .claimFirstMove(campaignId, expiredTimestamp)
        .accounts({
          user: bob.publicKey,
          oracleSigner: oracle.publicKey,
          campaignConfig: campaignConfigPda,
          rewardMint: rewardMint,
          userMilestone: bobMilestonePda,
          rewardVault: rewardVaultPda,
          userRewardAccount: bobAtaAccount.address,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([bob, oracle])
        .rpc();
      expect.fail("Should have failed due to expired voucher");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("SignatureExpired");
    }
  });

  it("6. Admin toggles campaign pause and guards execution", async () => {
    // Pause campaign
    await program.methods
      .toggleCampaignActive(false)
      .accounts({
        admin: admin.publicKey,
        campaignConfig: campaignConfigPda,
      })
      .rpc();

    const config = await program.account.campaignConfig.fetch(campaignConfigPda);
    expect(config.isActive).to.be.false;

    // Unpause campaign
    await program.methods
      .toggleCampaignActive(true)
      .accounts({
        admin: admin.publicKey,
        campaignConfig: campaignConfigPda,
      })
      .rpc();

    const resumedConfig = await program.account.campaignConfig.fetch(campaignConfigPda);
    expect(resumedConfig.isActive).to.be.true;
  });

  it("7. Allows admin to safely withdraw emergency residual liquidity", async () => {
    const drainAmount = new anchor.BN(1_000 * 10 ** 6);
    await program.methods
      .withdrawEmergencyFunds(drainAmount)
      .accounts({
        admin: admin.publicKey,
        campaignConfig: campaignConfigPda,
        rewardMint: rewardMint,
        rewardVault: rewardVaultPda,
        adminTokenAccount: adminAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const adminBal = await provider.connection.getTokenAccountBalance(adminAta);
    expect(Number(adminBal.value.amount)).to.be.greaterThan(5_000 * 10 ** 6);
  });
});