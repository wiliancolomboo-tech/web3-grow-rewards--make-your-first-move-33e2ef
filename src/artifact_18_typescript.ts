import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { GrowRewards } from "../target/types/grow_rewards";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import { AttestationService } from "../src/services/attestation";

describe("grow_rewards program enterprise suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GrowRewards as Program<GrowRewards>;

  const admin = provider.wallet;
  const oracleKeypair = Keypair.generate();
  const userKeypair = Keypair.generate();
  const adversaryKeypair = Keypair.generate();

  let rewardMint: PublicKey;
  let adminRewardAccount: PublicKey;
  let userRewardAccount: PublicKey;

  let configPda: PublicKey;
  let vaultPda: PublicKey;
  let userProgressPda: PublicKey;

  const attestation = new AttestationService(oracleKeypair.secretKey);
  const INITIAL_VAULT_FUNDING = new anchor.BN(100_000_000_000); // 100k tokens
  const REWARD_PER_MOVE = BigInt(1_000_000_000); // 1k tokens

  before(async () => {
    // 1. Airdrop SOL to participant wallets
    const airdropSig1 = await provider.connection.requestAirdrop(userKeypair.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    const airdropSig2 = await provider.connection.requestAirdrop(adversaryKeypair.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(airdropSig1);
    await provider.connection.confirmTransaction(airdropSig2);

    // 2. Create Reward SPL Token Mint
    rewardMint = await createMint(
      provider.connection,
      (admin as any).payer,
      admin.publicKey,
      null,
      6
    );

    // 3. Derive Program PDAs
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("global-config")],
      program.programId
    );

    [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("reward-vault"), rewardMint.toBuffer()],
      program.programId
    );

    [userProgressPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user-progress"), userKeypair.publicKey.toBuffer()],
      program.programId
    );

    // 4. Create ATAs
    const adminAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (admin as any).payer,
      rewardMint,
      admin.publicKey
    );
    adminRewardAccount = adminAta.address;

    const userAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (admin as any).payer,
      rewardMint,
      userKeypair.publicKey
    );
    userRewardAccount = userAta.address;

    // 5. Mint tokens to admin for pool funding
    await mintTo(
      provider.connection,
      (admin as any).payer,
      rewardMint,
      adminRewardAccount,
      admin.publicKey,
      200_000_000_000
    );
  });

  it("1. Successfully initializes the Grow Rewards engine and vault", async () => {
    const tx = await program.methods
      .initialize()
      .accounts({
        admin: admin.publicKey,
        oracleAuthority: oracleKeypair.publicKey,
        rewardMint,
        config: configPda,
        vault: vaultPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    expect(tx).to.be.a("string");

    const configAccount = await program.account.globalConfig.fetch(configPda);
    expect(configAccount.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(configAccount.oracleAuthority.toBase58()).to.equal(oracleKeypair.publicKey.toBase58());
    expect(configAccount.isPaused).to.be.false;
  });

  it("2. Funds the reward pool vault with SPL tokens", async () => {
    await program.methods
      .fundRewardPool(INITIAL_VAULT_FUNDING)
      .accounts({
        funder: admin.publicKey,
        config: configPda,
        rewardMint,
        vault: vaultPda,
        funderTokenAccount: adminRewardAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const vaultTokenAccount = await provider.connection.getTokenAccountBalance(vaultPda);
    expect(vaultTokenAccount.value.amount).to.equal(INITIAL_VAULT_FUNDING.toString());
  });

  it("3. User executes valid 'First Move' and claims reward with Ed25519 voucher", async () => {
    const milestoneId = 0; // First Move: Initial Protocol Deposit
    const nonce = BigInt(1);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const voucher = attestation.createSignedVoucher({
      userPubkey: userKeypair.publicKey,
      milestoneId,
      rewardAmount: REWARD_PER_MOVE,
      nonce,
      deadline,
    });

    const tx = new anchor.web3.Transaction();
    // 1st instruction: Ed25519 pre-instruction
    tx.add(voucher.instruction);
    // 2nd instruction: Program Claim instruction
    tx.add(
      await program.methods
        .verifyAndClaimReward(
          milestoneId,
          new anchor.BN(REWARD_PER_MOVE.toString()),
          new anchor.BN(nonce.toString()),
          new anchor.BN(deadline.toString())
        )
        .accounts({
          user: userKeypair.publicKey,
          config: configPda,
          rewardMint,
          vault: vaultPda,
          userProgress: userProgressPda,
          userRewardAccount,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    await provider.sendAndConfirm(tx, [userKeypair]);

    const userBalance = await provider.connection.getTokenAccountBalance(userRewardAccount);
    expect(userBalance.value.amount).to.equal(REWARD_PER_MOVE.toString());

    const progress = await program.account.userProgress.fetch(userProgressPda);
    expect(progress.claimedMilestoneMask).to.equal(1); // Bit 0 set
    expect(progress.totalRewardsReceived.toString()).to.equal(REWARD_PER_MOVE.toString());
  });

  it("4. Prevents Replay Attack: Re-submitting the same milestone claim fails", async () => {
    const milestoneId = 0;
    const nonce = BigInt(2);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const voucher = attestation.createSignedVoucher({
      userPubkey: userKeypair.publicKey,
      milestoneId,
      rewardAmount: REWARD_PER_MOVE,
      nonce,
      deadline,
    });

    const tx = new anchor.web3.Transaction();
    tx.add(voucher.instruction);
    tx.add(
      await program.methods
        .verifyAndClaimReward(
          milestoneId,
          new anchor.BN(REWARD_PER_MOVE.toString()),
          new anchor.BN(nonce.toString()),
          new anchor.BN(deadline.toString())
        )
        .accounts({
          user: userKeypair.publicKey,
          config: configPda,
          rewardMint,
          vault: vaultPda,
          userProgress: userProgressPda,
          userRewardAccount,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    try {
      await provider.sendAndConfirm(tx, [userKeypair]);
      expect.fail("Transaction should have failed with MilestoneAlreadyClaimed");
    } catch (err: any) {
      expect(err.toString()).to.include("MilestoneAlreadyClaimed");
    }
  });

  it("5. Prevents Forged Vouchers: Rogue signature fails instruction verification", async () => {
    const rogueOracle = Keypair.generate();
    const rogueAttestation = new AttestationService(rogueOracle.secretKey);

    const milestoneId = 1;
    const nonce = BigInt(3);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const forgedVoucher = rogueAttestation.createSignedVoucher({
      userPubkey: userKeypair.publicKey,
      milestoneId,
      rewardAmount: REWARD_PER_MOVE,
      nonce,
      deadline,
    });

    const tx = new anchor.web3.Transaction();
    tx.add(forgedVoucher.instruction);
    tx.add(
      await program.methods
        .verifyAndClaimReward(
          milestoneId,
          new anchor.BN(REWARD_PER_MOVE.toString()),
          new anchor.BN(nonce.toString()),
          new anchor.BN(deadline.toString())
        )
        .accounts({
          user: userKeypair.publicKey,
          config: configPda,
          rewardMint,
          vault: vaultPda,
          userProgress: userProgressPda,
          userRewardAccount,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    try {
      await provider.sendAndConfirm(tx, [userKeypair]);
      expect.fail("Should have failed with InvalidOracleSignature");
    } catch (err: any) {
      expect(err.toString()).to.include("InvalidOracleSignature");
    }
  });

  it("6. Admin Circuit Breaker: Pausing halts all reward claims", async () => {
    // 1. Pause
    await program.methods
      .emergencyPause(true)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();

    // 2. Try claiming Milestone 1 while paused
    const milestoneId = 1;
    const nonce = BigInt(4);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const voucher = attestation.createSignedVoucher({
      userPubkey: userKeypair.publicKey,
      milestoneId,
      rewardAmount: REWARD_PER_MOVE,
      nonce,
      deadline,
    });

    const tx = new anchor.web3.Transaction();
    tx.add(voucher.instruction);
    tx.add(
      await program.methods
        .verifyAndClaimReward(
          milestoneId,
          new anchor.BN(REWARD_PER_MOVE.toString()),
          new anchor.BN(nonce.toString()),
          new anchor.BN(deadline.toString())
        )
        .accounts({
          user: userKeypair.publicKey,
          config: configPda,
          rewardMint,
          vault: vaultPda,
          userProgress: userProgressPda,
          userRewardAccount,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
    );

    try {
      await provider.sendAndConfirm(tx, [userKeypair]);
      expect.fail("Should have failed due to ProtocolPaused");
    } catch (err: any) {
      expect(err.toString()).to.include("ProtocolPaused");
    }

    // 3. Unpause
    await program.methods
      .emergencyPause(false)
      .accounts({
        admin: admin.publicKey,
        config: configPda,
      })
      .rpc();
  });
});