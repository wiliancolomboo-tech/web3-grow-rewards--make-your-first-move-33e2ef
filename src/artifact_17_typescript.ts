#!/usr/bin/env node
import { Command } from "commander";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { NotificationDispatcher } from "./services/notifications";
import { AttestationService } from "./services/attestation";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const program = new Command();

program
  .name("grow-rewards")
  .description("Enterprise CLI for Grow Rewards: Make Your First Move Engine")
  .version("1.0.0");

function loadKeypair(path: string): Keypair {
  const secretKey = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secretKey));
}

program
  .command("issue-voucher")
  .description("Generate an Ed25519 cryptographic voucher for user First Move claim")
  .requiredOption("-u, --user <pubkey>", "User public key")
  .requiredOption("-m, --milestone <number>", "Milestone index (0-31)", "0")
  .requiredOption("-a, --amount <number>", "Reward amount in base atomic units", "1000000000")
  .requiredOption("-k, --oracle-key <path>", "Path to oracle keypair JSON file")
  .option("-t, --ttl <seconds>", "Time-to-live in seconds", "3600")
  .action(async (options) => {
    const oracleKeypair = loadKeypair(options.oracleKey);
    const attestation = new AttestationService(oracleKeypair.secretKey);

    const userPubkey = new PublicKey(options.user);
    const milestoneId = parseInt(options.milestone, 10);
    const rewardAmount = BigInt(options.amount);
    const nonce = BigInt(Date.now());
    const deadline = BigInt(Math.floor(Date.now() / 1000) + parseInt(options.ttl, 10));

    const { signature } = attestation.createSignedVoucher({
      userPubkey,
      milestoneId,
      rewardAmount,
      nonce,
      deadline,
    });

    console.log("=================================================");
    console.log("           GROW REWARDS VOUCHER ISSUED           ");
    console.log("=================================================");
    console.log(`User:         ${userPubkey.toBase58()}`);
    console.log(`Milestone ID: ${milestoneId}`);
    console.log(`Amount:       ${rewardAmount.toString()}`);
    console.log(`Nonce:        ${nonce.toString()}`);
    console.log(`Deadline:     ${deadline.toString()}`);
    console.log(`Signature:    ${Buffer.from(signature).toString("hex")}`);
    console.log("=================================================");
  });

program
  .command("test-notifications")
  .description("Verify Resend and Slack endpoints")
  .option("-e, --email <email>", "Test recipient email")
  .action(async (options) => {
    const dispatcher = new NotificationDispatcher({
      resendApiKey: process.env.RESEND_API_KEY,
      resendFromEmail: process.env.RESEND_FROM_EMAIL || "rewards@grow.solana.io",
      slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    });

    console.log("Testing outbound enterprise integrations...");

    if (options.email) {
      const emailSuccess = await dispatcher.sendMilestoneEmail(
        options.email,
        "First Move: Swap $10 on Jupiter",
        "50 GROW"
      );
      console.log(`Resend Email dispatch result: ${emailSuccess ? "SUCCESS" : "FAILED"}`);
    }

    const slackSuccess = await dispatcher.sendSlackAlert(
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      0,
      "50 GROW",
      "5VERv8NMvQbJepMz8WddKKEoB2FF6mNnLdGk36D45Q2XQ1S6TfAepBkW5k8P1Pz3a7d2Wf1f"
    );
    console.log(`Slack Webhook dispatch result: ${slackSuccess ? "SUCCESS" : "FAILED"}`);
  });

program.parse(process.argv);