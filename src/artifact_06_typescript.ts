import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  Transaction,
  Ed25519Program,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as nacl from "tweetnacl";

export class GrowRewardsClient {
  public program: Program;
  public provider: anchor.AnchorProvider;

  constructor(program: Program, provider: anchor.AnchorProvider) {
    this.program = program;
    this.provider = provider;
  }

  public getCampaignPDA(campaignId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), Buffer.from(campaignId)],
      this.program.programId
    );
  }

  public getVaultPDA(campaignId: string): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("reward_vault"), Buffer.from(campaignId)],
      this.program.programId
    );
  }

  public getUserRecordPDA(campaignId: string, userPubkey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("user_record"),
        Buffer.from(campaignId),
        userPubkey.toBuffer(),
      ],
      this.program.programId
    );
  }

  /**
   * Generates ed25519 signature for first move verification.
   */
  public static signAttestation(
    attestationAuthority: Keypair,
    userPubkey: PublicKey,
    campaignId: string,
    actionType: number,
    nonce: bigint
  ): { signature: Uint8Array; message: Uint8Array } {
    const campaignBuffer = Buffer.alloc(32);
    Buffer.from(campaignId).copy(campaignBuffer, 0, 0, 32);

    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(nonce);

    const message = Buffer.concat([
      userPubkey.toBuffer(),
      campaignBuffer,
      Buffer.from([actionType]),
      nonceBuffer,
    ]);

    const signature = nacl.sign.detached(message, attestationAuthority.secretKey);
    return { signature, message };
  }

  /**
   * Builds an atomic transaction containing the Ed25519 verification instruction
   * and the claim_first_move program call.
   */
  public async createClaimFirstMoveTx(params: {
    user: PublicKey;
    campaignId: string;
    rewardMint: PublicKey;
    actionType: number;
    nonce: bigint;
    attestationAuthorityPubkey: PublicKey;
    signature: Uint8Array;
  }): Promise<Transaction> {
    const campaignBuffer = Buffer.alloc(32);
    Buffer.from(params.campaignId).copy(campaignBuffer, 0, 0, 32);

    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(params.nonce);

    const message = Buffer.concat([
      params.user.toBuffer(),
      campaignBuffer,
      Buffer.from([params.actionType]),
      nonceBuffer,
    ]);

    // 1. Build Ed25519 Program Instruction
    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: params.attestationAuthorityPubkey.toBytes(),
      message: message,
      signature: params.signature,
    });

    const [campaignPDA] = this.getCampaignPDA(params.campaignId);
    const [vaultPDA] = this.getVaultPDA(params.campaignId);
    const [userRecordPDA] = this.getUserRecordPDA(params.campaignId, params.user);
    const userAta = getAssociatedTokenAddressSync(params.rewardMint, params.user);

    // 2. Build Claim Instruction
    const claimInstruction = await this.program.methods
      .claimFirstMove(
        params.actionType,
        new anchor.BN(params.nonce.toString()),
        Array.from(params.signature)
      )
      .accounts({
        user: params.user,
        campaign: campaignPDA,
        userRecord: userRecordPDA,
        rewardVault: vaultPDA,
        userTokenAccount: userAta,
        rewardMint: params.rewardMint,
        ixSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const tx = new Transaction();
    tx.add(ed25519Instruction);
    tx.add(claimInstruction);
    return tx;
  }
}