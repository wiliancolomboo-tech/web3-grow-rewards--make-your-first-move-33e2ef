import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { GrowRewards } from "../target/types/grow_rewards";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("grow_rewards unit and integration test suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GrowRewards as Program<GrowRewards>;

  let rewardMint: PublicKey;
  let adminKeypair: Keypair;
  let userKeypair: Keypair;
  let attackerKeypair: Keypair;

  let configPda: PublicKey;
  let configBump: number;
  let vaultAuthorityPda: PublicKey;
  let vaultBump: number;
  let rewardVaultPda: PublicKey;

  let userStatePda: PublicKey;
  let userTokenAccount: PublicKey;
  let attackerTokenAccount: PublicKey;

  const BASE_REWARD = new anchor.BN(10_000_000); // 10 tokens (with 6 decimals)
  const COOLDOWN_SECONDS = new anchor.BN(5); // 5 seconds for rapid testing
  const MAX_MULTIPLIER_BPS = 30_000; // 3x cap

  before(async () => {
    adminKeypair = Keypair.generate();
    userKeypair = Keypair.generate();
    attackerKeypair = Keypair.generate();

    // Airdrop SOL to test participants
    for (const kp of [adminKeypair, userKeypair, attackerKeypair]) {
      const airdropSig = await provider.connection.requestAirdrop(
        kp.publicKey,
        5 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(airdropSig, "confirmed");
    }

    // Derive Global PDAs
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("grow_config")],
      program.programId
    );

    [vaultAuthorityPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_authority"), configPda.toBuffer()],
      program.programId
    );

    [rewardVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), configPda.toBuffer()],
      program.programId
    );

    // Derive User State PDA
    [userStatePda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_state"),
        configPda.toBuffer(),
        userKeypair.publicKey.toBuffer(),
      ],
      program.programId
    );

    // Create Mock SPL Reward Mint
    rewardMint = await createMint(
      provider.connection,
      adminKeypair,
      adminKeypair.publicKey,
      null,
      6
    );

    // Create User & Attacker Token Accounts
    userTokenAccount = await createAccount(
      provider.connection,
      userKeypair,
      rewardMint,
      userKeypair.publicKey
    );

    attackerTokenAccount = await createAccount(
      provider.connection,
      attackerKeypair,
      rewardMint,
      attackerKeypair.publicKey
    );
  });

  it("1. Successfully initializes protocol and PDA reward vault", async () => {
    const tx = await program.methods
      .initializeProtocol(BASE_REWARD, COOLDOWN_SECONDS, MAX_MULTIPLIER_BPS)
      .accounts({
        config: configPda,
        rewardMint: rewardMint,
        rewardVault: rewardVaultPda,
        vaultAuthority: vaultAuthorityPda,
        authority: adminKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([adminKeypair])
      .rpc();

    expect(tx).to.be.a("string");

    const configAccount = await program.account.config.fetch(configPda);
    expect(configAccount.authority.toBase58()).to.equal(adminKeypair.publicKey.toBase58());
    expect(configAccount.rewardMint.toBase58()).to.equal(rewardMint.toBase58());
    expect(configAccount.baseRewardAmount.eq(BASE_REWARD)).to.be.true;
    expect(configAccount.isPaused).to.be.false;

    // Fund the PDA Reward Vault with 1,000 SPL Tokens
    await mintTo(
      provider.connection,
      adminKeypair,
      rewardMint,
      rewardVaultPda,
      adminKeypair,
      1_000_000_000
    );

    const vaultBalance = await getAccount(provider.connection, rewardVaultPda);
    expect(Number(vaultBalance.amount)).to.equal(1_000_000_000);
  });

  it("2. Initializes User Profile PDA", async () => {
    await program.methods
      .initializeUser()
      .accounts({
        config: configPda,
        userState: userStatePda,
        user: userKeypair.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userKeypair])
      .rpc();

    const userState = await program.account.userAccount.fetch(userStatePda);
    expect(userState.user.toBase58()).to.equal(userKeypair.publicKey.toBase58());
    expect(userState.firstMoveCompleted).to.be.false;
    expect(userState.milestoneTier).to.equal(0);
    expect(userState.totalRewardsEarned.toNumber()).to.equal(0);
  });

  it("3. Executes 'Make Your First Move' and transfers exact calculated SPL reward", async () => {
    const actionWeightBps = 15_000; // 1.5x multiplier
    const mockProof = crypto.randomBytes(32);

    const initialUserAccount = await getAccount(provider.connection, userTokenAccount);
    expect(Number(initialUserAccount.amount)).to.equal(0);

    await program.methods
      .executeFirstMove(actionWeightBps, Array.from(mockProof))
      .accounts({
        config: configPda,
        userState: userStatePda,
        rewardVault: rewardVaultPda,
        vaultAuthority: vaultAuthorityPda,
        userTokenAccount: userTokenAccount,
        user: userKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userKeypair])
      .rpc();

    // Verify User State
    const userState = await program.account.userAccount.fetch(userStatePda);
    expect(userState.firstMoveCompleted).to.be.true;
    expect(userState.milestoneTier).to.equal(1);
    expect(userState.totalActions.toNumber()).to.equal(1);

    // Expected reward = 10_000_000 * 15_000 / 10_000 = 15_000_000 (15 tokens)
    expect(userState.totalRewardsEarned.toNumber()).to.equal(15_000_000);

    // Verify SPL Token balance received
    const postUserAccount = await getAccount(provider.connection, userTokenAccount);
    expect(Number(postUserAccount.amount)).to.equal(15_000_000);
  });

  it("4. Blocks duplicate action when cooldown window is active (Anti-Spam)", async () => {
    const actionWeightBps = 10_000; // 1.0x multiplier
    const mockProof = crypto.randomBytes(32);

    try {
      await program.methods
        .executeFirstMove(actionWeightBps, Array.from(mockProof))
        .accounts({
          config: configPda,
          userState: userStatePda,
          rewardVault: rewardVaultPda,
          vaultAuthority: vaultAuthorityPda,
          userTokenAccount: userTokenAccount,
          user: userKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userKeypair])
        .rpc();
      expect.fail("Expected cooldown error to be thrown");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("CooldownPeriodActive");
    }
  });

  it("5. Rejects unauthorized attempts to drain vault by non-admin attacker", async () => {
    try {
      await program.methods
        .emergencyWithdrawVault(new anchor.BN(50_000_000))
        .accounts({
          config: configPda,
          rewardVault: rewardVaultPda,
          vaultAuthority: vaultAuthorityPda,
          destinationTokenAccount: attackerTokenAccount,
          authority: attackerKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([attackerKeypair])
        .rpc();
      expect.fail("Attacker must not be able to withdraw from vault");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("UnauthorizedAdmin");
    }
  });

  it("6. Allows next milestone move after cooldown expires", async () => {
    // Wait for the 5-second cooldown to elapse
    await new Promise((resolve) => setTimeout(resolve, 5500));

    const actionWeightBps = 10_000; // 1.0x multiplier
    const mockProof = crypto.randomBytes(32);

    await program.methods
      .executeFirstMove(actionWeightBps, Array.from(mockProof))
      .accounts({
        config: configPda,
        userState: userStatePda,
        rewardVault: rewardVaultPda,
        vaultAuthority: vaultAuthorityPda,
        userTokenAccount: userTokenAccount,
        user: userKeypair.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userKeypair])
      .rpc();

    const userState = await program.account.userAccount.fetch(userStatePda);
    expect(userState.milestoneTier).to.equal(2);
    expect(userState.totalActions.toNumber()).to.equal(2);
    expect(userState.totalRewardsEarned.toNumber()).to.equal(25_000_000); // 15 + 10 = 25 tokens
  });

  it("7. Emergency pause prevents further user reward payouts", async () => {
    // Admin toggles pause
    await program.methods
      .setPaused(true)
      .accounts({
        config: configPda,
        authority: adminKeypair.publicKey,
      })
      .signers([adminKeypair])
      .rpc();

    const configAccount = await program.account.config.fetch(configPda);
    expect(configAccount.isPaused).to.be.true;

    // Wait cooldown just to ensure pause is the sole blocker
    await new Promise((resolve) => setTimeout(resolve, 5200));

    try {
      await program.methods
        .executeFirstMove(10_000, Array.from(crypto.randomBytes(32)))
        .accounts({
          config: configPda,
          userState: userStatePda,
          rewardVault: rewardVaultPda,
          vaultAuthority: vaultAuthorityPda,
          userTokenAccount: userTokenAccount,
          user: userKeypair.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userKeypair])
        .rpc();
      expect.fail("Execution must revert while protocol is paused");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("ProgramPaused");
    }

    // Admin unpauses protocol
    await program.methods
      .setPaused(false)
      .accounts({
        config: configPda,
        authority: adminKeypair.publicKey,
      })
      .signers([adminKeypair])
      .rpc();
  });
});