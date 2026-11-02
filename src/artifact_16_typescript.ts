import { PublicKey, Ed25519Program, TransactionInstruction } from "@solana/web3.js";
import nacl from "tweetnacl";

export interface VoucherParams {
  userPubkey: PublicKey;
  milestoneId: number;
  rewardAmount: bigint;
  nonce: bigint;
  deadline: bigint;
}

export class AttestationService {
  constructor(private oracleSecretKey: Uint8Array) {}

  public get oraclePublicKey(): PublicKey {
    const keypair = nacl.sign.keyPair.fromSecretKey(this.oracleSecretKey);
    return new PublicKey(keypair.publicKey);
  }

  public createSignedVoucher(params: VoucherParams): {
    instruction: TransactionInstruction;
    signature: Uint8Array;
    message: Uint8Array;
  } {
    // Layout: [user(32) || milestone(1) || amount(8 LE) || nonce(8 LE) || deadline(8 LE)]
    const message = new Uint8Array(32 + 1 + 8 + 8 + 8);
    message.set(params.userPubkey.toBytes(), 0);
    message[32] = params.milestoneId;

    const amountBuffer = Buffer.alloc(8);
    amountBuffer.writeBigUInt64LE(params.rewardAmount);
    message.set(amountBuffer, 33);

    const nonceBuffer = Buffer.alloc(8);
    nonceBuffer.writeBigUInt64LE(params.nonce);
    message.set(nonceBuffer, 41);

    const deadlineBuffer = Buffer.alloc(8);
    deadlineBuffer.writeBigInt64LE(params.deadline);
    message.set(deadlineBuffer, 49);

    const signature = nacl.sign.detached(message, this.oracleSecretKey);

    const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: this.oraclePublicKey.toBytes(),
      message,
      signature,
    });

    return {
      instruction: ed25519Instruction,
      signature,
      message,
    };
  }
}