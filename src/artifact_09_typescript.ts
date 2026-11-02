import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { GrowRewards } from "../target/types/grow_rewards";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { GrowRewardsClient } from "../src/client/growClient";

describe("Grow Rewards: Make Your First Move - Test Suite", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GrowRewards as Program<GrowRewards>;
  const client = new GrowRewardsClient(program, provider);

  const admin = Keypair.generate();
  const attestationAuthority = Keypair.generate();
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  let rewardMint: PublicKey;
  let adminTokenAccount: PublicKey;
  const campaignId = "solana-first-move-2025";
  const rewardAmount = new anchor.BN(10_000_000); // 10 tokens (decimals = 6)
  const maxClaims = new anchor.BN(5);

  before(async () => {
    // Airdrop SOL to test actors
    for (const actor of [admin, attestationAuthority, user1, user2]) {
      const sig = await provider.connection.requestAirdrop(
        actor.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
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

    // Create Admin Token Account and mint funds
    adminTokenAccount = await createAccount(
      provider.connection,
      admin,
      rewardMint,
      admin.publicKey
    );

    await mintTo(
      provider.connection,
      admin,
      rewardMint,
      adminTokenAccount,
      admin,
      100_000_000 // 100 tokens
    );
  });

  it("1. Initializes Campaign PDA & Vault with strict bounds", async () => {
    const [campaignPDA] = client.getCampaignPDA(campaignId);
    const [vaultPDA] = client.getVaultPDA(campaignId);

    await program.methods
      .initializeCampaign(
        campaignId,
        rewardAmount,
        maxClaims,
        attestationAuthority.publicKey
      )
      .accounts({
        admin: admin.publicKey,
        rewardMint: rewardMint,
        campaign: campaignPDA,
        rewardVault: vaultPDA,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    const campaignState = await program.account.campaign.fetch(campaignPDA);
    expect(campaignState.campaignId).to.equal(campaignId);
    expect(campaignState.rewardAmountPerUser.eq(rewardAmount)).to.be.true;
    expect(campaignState.totalClaims.toNumber()).to.equal(0);
    expect(campaignState.isActive).to.be.true;
    expect(campaignState.attestationSigner.toBase58()).to.equal(
      attestationAuthority.publicKey.toBase58()
    );
  });

  it("2. Deposits SPL reward tokens into the campaign vault", async () => {
    const [campaignPDA] = client.getCampaignPDA(campaignId);
    const [vaultPDA] = client.getVaultPDA(campaignId);
    const depositAmount = new anchor.BN(50_000_000);

    await program.methods
      .depositRewards(depositAmount)
      .accounts({
        depositor: admin.publicKey,
        campaign: campaignPDA,
        rewardVault: vaultPDA,
        depositorTokenAccount: adminTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultPDA);
    expect(Number(vaultAccount.amount)).to.equal(50_000_000);
  });

  it("3. User executes claim_first_move with valid Ed25519 signature", async () => {
    const actionType = 1; // 1 = First Swap/Deposit
    const nonce = 1001n;

    const { signature } = GrowRewardsClient.signAttestation(
      attestationAuthority,
      user1.publicKey,
      campaignId,
      actionType,
      nonce
    );

    const tx = await client.createClaimFirstMoveTx({
      user: user1.publicKey,
      campaignId,
      rewardMint,
      actionType,
      nonce,
      attestationAuthorityPubkey: attestationAuthority.publicKey,
      signature,
    });

    const sig = await sendAndConfirmTransaction(provider.connection, tx, [user1]);
    expect(sig).to.be.a("string");

    // Validate User Record State
    const [userRecordPDA] = client.getUserRecordPDA(campaignId, user1.publicKey);
    const record = await program.account.userFirstMoveRecord.fetch(userRecordPDA);
    expect(record.user.toBase58()).to.equal(user1.publicKey.toBase58());
    expect(record.actionType).to.equal(actionType);
    expect(record.rewardAmount.eq(rewardAmount)).to.be.true;

    // Validate SPL Reward Transfer
    const userAta = getAssociatedTokenAddressSync(rewardMint, user1.publicKey);
    const tokenAcc = await getAccount(provider.connection, userAta);
    expect(Number(tokenAcc.amount)).to.equal(10_000_000);

    // Validate Campaign total claims increment
    const [campaignPDA] = client.getCampaignPDA(campaignId);
    const campaign = await program.account.campaign.fetch(campaignPDA);
    expect(campaign.totalClaims.toNumber()).to.equal(1);
  });

  it("4. Rejects double-claim from the same user (Sybil & Replay Guard)", async () => {
    const actionType = 1;
    const nonce = 1002n;

    const { signature } = GrowRewardsClient.signAttestation(
      attestationAuthority,
      user1.publicKey,
      campaignId,
      actionType,
      nonce
    );

    const tx = await client.createClaimFirstMoveTx({
      user: user1.publicKey,
      campaignId,
      rewardMint,
      actionType,
      nonce,
      attestationAuthorityPubkey: attestationAuthority.publicKey,
      signature,
    });

    try {
      await sendAndConfirmTransaction(provider.connection, tx, [user1]);
      expect.fail("Should have failed on duplicate PDA creation");
    } catch (err: any) {
      // PDA already initialized error
      expect(err.toString()).to.include("already in use");
    }
  });

  it("5. Rejects counterfeit attestation signature (Tampered Authority)", async () => {
    const fraudulentAttestation = Keypair.generate();
    const actionType = 1;
    const nonce = 2001n;

    const { signature } = GrowRewardsClient.signAttestation(
      fraudulentAttestation, // Unauthorized signer
      user2.publicKey,
      campaignId,
      actionType,
      nonce
    );

    const tx = await client.createClaimFirstMoveTx({
      user: user2.publicKey,
      campaignId,
      rewardMint,
      actionType,
      nonce,
      attestationAuthorityPubkey: fraudulentAttestation.publicKey,
      signature,
    });

    try {
      await sendAndConfirmTransaction(provider.connection, tx, [user2]);
      expect.fail("Should have thrown UnauthorizedAttestationSigner");
    } catch (err: any) {
      expect(err.toString()).to.include("UnauthorizedAttestationSigner");
    }
  });

  it("6. Admin closes campaign and reclaims unallocated rewards", async () => {
    const [campaignPDA] = client.getCampaignPDA(campaignId);
    const [vaultPDA] = client.getVaultPDA(campaignId);

    const initialAdminBalance = (await getAccount(provider.connection, adminTokenAccount)).amount;

    await program.methods
      .closeCampaign()
      .accounts({
        admin: admin.publicKey,
        campaign: campaignPDA,
        rewardVault: vaultPDA,
        adminTokenAccount: adminTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([admin])
      .rpc();

    const finalAdminBalance = (await getAccount(provider.connection, adminTokenAccount)).amount;
    expect(Number(finalAdminBalance)).to.equal(Number(initialAdminBalance) + 40_000_000);

    const campaignClosed = await provider.connection.getAccountInfo(campaignPDA);
    expect(campaignClosed).to.be.null;
  });
});