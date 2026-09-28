import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair, Connection, clusterApiUrl } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Resend } from "resend";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY || "re_test_dummy_key_123456";
const OPS_WEBHOOK_URL = process.env.OPS_WEBHOOK_URL || "";
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl("devnet");
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "GrwRew1111111111111111111111111111111111111"
);

const resend = new Resend(RESEND_API_KEY);
const programInterface = JSON.parse(
  fs.readFileSync("./target/idl/grow_rewards.json", "utf8")
);

const program = new Command();

program
  .name("grow-agent")
  .description("Turnkey Orchestration Agent for Grow Rewards")
  .version("1.0.0");

/**
 * Enterprise Notification Relayer
 */
async function notifyEnterpriseChannels(params: {
  userWallet: string;
  userEmail?: string;
  campaignId: string;
  amountFormatted: string;
  multiplier: string;
  txHash: string;
}) {
  console.log(`[TELEMETRY] Dispatching events for user ${params.userWallet}...`);

  // 1. Send Email Notification via Resend if email is attached
  if (params.userEmail) {
    try {
      const emailResp = await resend.emails.send({
        from: "Grow Rewards <rewards@grow-rewards.enterprise>",
        to: [params.userEmail],
        subject: "🎉 Your First Move Reward Has Been Credited on Solana!",
        html: `
          <div style="font-family: Arial, sans-serif; padding: 24px; color: #111;">
            <h2>Congratulations! Your First Move is Verified.</h2>
            <p>You have successfully unlocked your initial protocol activation reward.</p>
            <ul>
              <li><strong>Reward Accrued:</strong> ${params.amountFormatted} SPL Tokens</li>
              <li><strong>Early Mover Multiplier:</strong> ${params.multiplier}</li>
              <li><strong>Solana Transaction:</strong> <a href="https://solscan.io/tx/${params.txHash}?cluster=devnet">${params.txHash}</a></li>
            </ul>
            <p>Keep growing your position to unlock tier-2 engagement rewards.</p>
          </div>
        `,
      });
      console.log(`[RESEND SUCCESS] Sent notification ID: ${emailResp.data?.id}`);
    } catch (err: any) {
      console.error(`[RESEND FAILURE] Failed to send email: ${err.message}`);
    }
  }

  // 2. Dispatch Slack / Discord Webhook Telemetry
  if (OPS_WEBHOOK_URL) {
    try {
      await axios.post(OPS_WEBHOOK_URL, {
        content: `🚀 **First Move Claimed!**\n- **User:** \`${params.userWallet}\`\n- **Campaign:** #${params.campaignId}\n- **Payout:** ${params.amountFormatted} (Multiplier: ${params.multiplier})\n- **Explorer:** https://solscan.io/tx/${params.txHash}`,
      });
      console.log(`[WEBHOOK SUCCESS] Dispatched to Ops channel.`);
    } catch (err: any) {
      console.error(`[WEBHOOK FAILURE] Failed webhook delivery: ${err.message}`);
    }
  }
}

/**
 * Command: Process and verify first move claim
 */
program
  .command("execute-claim")
  .description("Process an attestation and claim the reward on-chain")
  .requiredOption("--campaign-id <number>", "Campaign identifier")
  .requiredOption("--user-keypair <path>", "Path to user private key JSON")
  .requiredOption("--verifier-keypair <path>", "Path to verifier private key JSON")
  .requiredOption("--reward-mint <pubkey>", "Mint address of the reward token")
  .option("--user-email <email>", "Optional user email for Resend attribution")
  .action(async (options) => {
    try {
      const connection = new Connection(SOLANA_RPC_URL, "confirmed");
      const userKeypair = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(options.userKeypair, "utf8")))
      );
      const verifierKeypair = Keypair.fromSecretKey(
        new Uint8Array(JSON.parse(fs.readFileSync(options.verifierKeypair, "utf8")))
      );
      const campaignId = new anchor.BN(options.campaignId);
      const rewardMint = new PublicKey(options.rewardMint);

      const wallet = new anchor.Wallet(userKeypair);
      const provider = new anchor.AnchorProvider(connection, wallet, {
        commitment: "confirmed",
      });
      const anchorProgram = new anchor.Program(programInterface, PROGRAM_ID, provider);

      // Derive Program PDAs
      const [campaignPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("grow_campaign"), campaignId.toArrayLike(Buffer, "le", 8)],
        PROGRAM_ID
      );
      const [rewardVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("reward_vault"), campaignId.toArrayLike(Buffer, "le", 8)],
        PROGRAM_ID
      );
      const [userTrackerPda] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("user_tracker"),
          campaignId.toArrayLike(Buffer, "le", 8),
          userKeypair.publicKey.toBuffer(),
        ],
        PROGRAM_ID
      );

      const userAta = getAssociatedTokenAddressSync(rewardMint, userKeypair.publicKey);
      const timestamp = Math.floor(Date.now() / 1000);
      const dummyActionSig = new Uint8Array(64).fill(7); // Synthetic attestation payload

      console.log(`[ORCHESTRATOR] Submitting claim for ${userKeypair.publicKey.toBase58()}...`);

      const tx = await anchorProgram.methods
        .claimFirstMove(Array.from(dummyActionSig), new anchor.BN(timestamp))
        .accounts({
          user: userKeypair.publicKey,
          verifierAuthority: verifierKeypair.publicKey,
          campaign: campaignPda,
          userTracker: userTrackerPda,
          rewardVault: rewardVaultPda,
          userRewardAccount: userAta,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .signers([userKeypair, verifierKeypair])
        .rpc();

      console.log(`[TRANSACTION CONFIRMED] TX ID: ${tx}`);

      // Dispatch real-time enterprise webhooks
      await notifyEnterpriseChannels({
        userWallet: userKeypair.publicKey.toBase58(),
        userEmail: options.userEmail,
        campaignId: options.campaignId,
        amountFormatted: "100.00 GROW",
        multiplier: "2.5x Early Bird",
        txHash: tx,
      });
    } catch (err: any) {
      console.error(`[EXECUTION FAILED] Error:`, err);
      process.exit(1);
    }
  });

program.parse(process.argv);