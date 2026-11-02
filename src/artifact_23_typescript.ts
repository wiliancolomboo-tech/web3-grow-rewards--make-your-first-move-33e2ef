import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { GrowRewards } from "../target/types/grow_rewards";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAccount,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";

describe("grow_rewards: Make Your First Move Test Matrix", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.GrowRewards as Program<GrowRewards>;

  const campaignId = new anchor.BN(9001);
  const rewardAmountPerUser = new anchor.BN(50_000_000); // 50 Tokens (decimals = 6)
  const maxRecipients = new anchor.BN(5);
  const initialFundAmount = new anchor.BN(250_000_000); // 250 Tokens

  let rewardMint: PublicKey;
  let authorityAta: PublicKey;
  let campaignPDA: PublicKey;
  let vaultPDA: PublicKey;

  const testUser = Keypair.generate();
  let userAta: PublicKey;
  let userReceiptPDA: PublicKey;

  before(async () => {
    // 1. Airdrop SOL to testUser and authority
    const airdropSig = await provider.connection.requestAirdrop(
      testUser.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);

    // 2. Derive PDAs
    [campaignPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    [vaultPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), campaignPDA.toBuffer()],
      program.programId
    );
    [userReceiptPDA] = PublicKey.findProgramAddressSync(
      [Buffer.from("user-receipt"), campaignPDA.toBuffer(), testUser.publicKey.toBuffer()],
      program.programId
    );

    // 3. Create Mint and mint tokens to Authority
    rewardMint = await createMint(
      provider.connection,
      (provider.wallet as any).payer,
      provider.publicKey,
      null,
      6
    );

    const authorityTokenAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as any).payer,
      rewardMint,
      provider.publicKey
    );
    authorityAta = authorityTokenAcc.address;

    await mintTo(
      provider.connection,
      (provider.wallet as any).payer,
      rewardMint,
      authorityAta,
      provider.publicKey,
      1_000_000_000
    );

    // 4. Create User ATA
    const userTokenAcc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (provider.wallet as any).payer,
      rewardMint,
      testUser.publicKey
    );
    userAta = userTokenAcc.address;
  });

  it("1. Successfully initializes a new First-Move campaign", async () => {
    await program.methods
      .initializeCampaign(
        campaignId,
        rewardAmountPerUser,
        maxRecipients,
        "Solana Genesis Onboarding"
      )
      .accounts({
        authority: provider.publicKey,
        rewardMint,
        campaign: campaignPDA,
        vault: vaultPDA,
      })
      .rpc();

    const campaignState = await program.account.campaign.fetch(campaignPDA);
    expect(campaignState.authority.toBase58()).to.equal(provider.publicKey.toBase58());
    expect(campaignState.rewardAmountPerUser.toNumber()).to.equal(rewardAmountPerUser.toNumber());
    expect(campaignState.maxRecipients.toNumber()).to.equal(maxRecipients.toNumber());
    expect(campaignState.totalClaimed.toNumber()).to.equal(0);
    expect(campaignState.isActive).to.be.true;
    expect(campaignState.campaignName).to.equal("Solana Genesis Onboarding");
  });

  it("2. Funds the campaign vault with reward tokens", async () => {
    await program.methods
      .fundCampaignVault(initialFundAmount)
      .accounts({
        funder: provider.publicKey,
        campaign: campaignPDA,
        rewardMint,
        vault: vaultPDA,
        funderTokenAccount: authorityAta,
      })
      .rpc();

    const vaultAccount = await getAccount(provider.connection, vaultPDA);
    expect(Number(vaultAccount.amount)).to.equal(initialFundAmount.toNumber());
  });

  it("3. User executes 'First Move' and receives reward tokens atomically", async () => {
    const actionHash = Array.from(crypto.createHash("sha256").update("swap_action_tx_01").digest());

    await program.methods
      .claimFirstMoveReward(actionHash)
      .accounts({
        user: testUser.publicKey,
        campaign: campaignPDA,
        rewardMint,
        vault: vaultPDA,
        userReceipt: userReceiptPDA,
        userTokenAccount: userAta,
      })
      .signers([testUser])
      .rpc();

    // Verify User Token Balance increased
    const userAccount = await getAccount(provider.connection, userAta);
    expect(Number(userAccount.amount)).to.equal(rewardAmountPerUser.toNumber());

    // Verify User Receipt PDA exists and holds valid metadata
    const receipt = await program.account.userReceipt.fetch(userReceiptPDA);
    expect(receipt.user.toBase58()).to.equal(testUser.publicKey.toBase58());
    expect(receipt.amountClaimed.toNumber()).to.equal(rewardAmountPerUser.toNumber());
    expect(receipt.actionMetadataHash).to.deep.equal(actionHash);

    // Verify Campaign total_claimed counter incremented
    const campaignState = await program.account.campaign.fetch(campaignPDA);
    expect(campaignState.totalClaimed.toNumber()).to.equal(1);
  });

  it("4. Sybil Protection: Reject duplicate claim attempt by the same user", async () => {
    const duplicateHash = Array.from(crypto.randomBytes(32));

    try {
      await program.methods
        .claimFirstMoveReward(duplicateHash)
        .accounts({
          user: testUser.publicKey,
          campaign: campaignPDA,
          rewardMint,
          vault: vaultPDA,
          userReceipt: userReceiptPDA, // Already initialized!
          userTokenAccount: userAta,
        })
        .signers([testUser])
        .rpc();

      expect.fail("Should have failed due to account already in use");
    } catch (err: any) {
      // Anchor/Solana runtime throws 'account address already in use' during PDA initialization
      expect(err.toString()).to.include("already in use");
    }
  });

  it("5. Authority closes campaign and retrieves remaining unallocated vault tokens", async () => {
    const initialAuthorityBalance = Number(
      (await getAccount(provider.connection, authorityAta)).amount
    );
    const vaultBalanceBeforeClose = Number(
      (await getAccount(provider.connection, vaultPDA)).amount
    );

    await program.methods
      .closeCampaign()
      .accounts({
        authority: provider.publicKey,
        campaign: campaignPDA,
        rewardMint,
        vault: vaultPDA,
        authorityTokenAccount: authorityAta,
      })
      .rpc();

    // Authority should receive the refunded vault tokens
    const finalAuthorityBalance = Number(
      (await getAccount(provider.connection, authorityAta)).amount
    );
    expect(finalAuthorityBalance).to.equal(initialAuthorityBalance + vaultBalanceBeforeClose);

    // Campaign account should be closed
    const closedAccount = await provider.connection.getAccountInfo(campaignPDA);
    expect(closedAccount).to.be.null;
  });
});