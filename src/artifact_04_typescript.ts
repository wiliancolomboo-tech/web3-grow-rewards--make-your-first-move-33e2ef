import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import axios from "axios";
import { Resend } from "resend";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

// Configuration Interfaces
interface DaemonConfig {
  rpcUrl: string;
  wsUrl: string;
  programId: string;
  resendApiKey: string;
  discordWebhookUrl: string;
  notificationFromEmail: string;
  alertRecipientEmail: string;
}

const config: DaemonConfig = {
  rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  wsUrl: process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "GrowRew111111111111111111111111111111111111",
  resendApiKey: process.env.RESEND_API_KEY || "re_test_000000000000000000000000",
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || "",
  notificationFromEmail: process.env.NOTIFICATION_FROM_EMAIL || "rewards@grow.solana.domain",
  alertRecipientEmail: process.env.ALERT_RECIPIENT_EMAIL || "founder@growprotocol.io",
};

const resend = new Resend(config.resendApiKey);

// Anchor IDL Stub for Event Parsing
const IDL: anchor.Idl = {
  version: "0.1.0",
  name: "grow_rewards",
  instructions: [],
  events: [
    {
      name: "FirstMoveCompletedEvent",
      fields: [
        { name: "user", type: "publicKey", index: false },
        { name: "rewardAmount", type: "u64", index: false },
        { name: "milestoneTier", type: "u8", index: false },
        { name: "actionWeightBps", type: "u16", index: false },
        { name: "proofHash", type: { array: ["u8", 32] }, index: false },
        { name: "timestamp", type: "i64", index: false },
      ],
    },
  ],
};

export class GrowRewardsDaemon {
  private connection: Connection;
  private program: Program;
  private programId: PublicKey;

  constructor() {
    this.connection = new Connection(config.rpcUrl, {
      wsEndpoint: config.wsUrl,
      commitment: "confirmed",
    });
    this.programId = new PublicKey(config.programId);
    
    // Read-only dummy wallet for Anchor Program instance
    const dummyKeypair = Keypair.generate();
    const wallet = new anchor.Wallet(dummyKeypair);
    const provider = new anchor.AnchorProvider(this.connection, wallet, {
      commitment: "confirmed",
    });
    this.program = new Program(IDL, this.programId, provider);
  }

  public async start(): Promise<void> {
    console.log(`[BOOT] Grow Rewards Daemon listening on: ${this.programId.toBase58()}`);
    console.log(`[RPC] Connected to: ${config.rpcUrl}`);

    // Listen to program logs
    this.connection.onLogs(
      this.programId,
      async (logs, ctx) => {
        if (logs.err) return;

        for (const logLine of logs.logs) {
          if (logLine.includes("FirstMoveCompletedEvent")) {
            await this.handleLogEntry(logLine, logs.signature);
          }
        }
      },
      "confirmed"
    );

    // Initial Health Check
    await this.healthCheck();
  }

  private async handleLogEntry(logLine: string, signature: string): Promise<void> {
    try {
      console.log(`\n⚡ [FIRST MOVE DETECTED] Signature: ${signature}`);
      
      // Extract serialized event base64 log
      const prefix = "Program data: ";
      const logDataIndex = logLine.indexOf(prefix);
      if (logDataIndex === -1) return;

      const rawData = logLine.substring(logDataIndex + prefix.length);
      const decodedEvent = this.program.coder.events.decode(rawData);

      if (decodedEvent && decodedEvent.name === "FirstMoveCompletedEvent") {
        const payload = decodedEvent.data as {
          user: PublicKey;
          rewardAmount: anchor.BN;
          milestoneTier: number;
          actionWeightBps: number;
          proofHash: number[];
          timestamp: anchor.BN;
        };

        const userPubkey = payload.user.toBase58();
        const formattedAmount = (payload.rewardAmount.toNumber() / 1e6).toFixed(2);
        const tier = payload.milestoneTier;

        console.log(`-> User: ${userPubkey}`);
        console.log(`-> Reward Payout: ${formattedAmount} tokens (Tier: ${tier})`);

        // Trigger Notifications concurrently
        await Promise.allSettled([
          this.sendEnterpriseDiscordAlert(userPubkey, formattedAmount, tier, signature),
          this.sendResendWelcomeReceipt(userPubkey, formattedAmount, signature),
        ]);
      }
    } catch (err) {
      console.error("[EVENT HANDLER ERROR]", err);
    }
  }

  private async sendEnterpriseDiscordAlert(
    user: string,
    amount: string,
    tier: number,
    sig: string
  ): Promise<void> {
    if (!config.discordWebhookUrl) return;

    const payload = {
      username: "Grow Rewards Watchtower",
      avatar_url: "https://solana.com/src/img/branding/solanaLogoMark.png",
      embeds: [
        {
          title: "🎉 New User First Move Activated!",
          color: 0x14f195, // Solana Green
          fields: [
            { name: "Wallet", value: `\`${user}\``, inline: false },
            { name: "Reward Allocated", value: `**${amount} Tokens**`, inline: true },
            { name: "Milestone Tier", value: `Tier ${tier}`, inline: true },
            {
              name: "Solana Explorer",
              value: `[View Transaction](https://explorer.solana.com/tx/${sig}?cluster=devnet)`,
              inline: false,
            },
          ],
          timestamp: new Date().toISOString(),
          footer: { text: "Grow Rewards Engine v1.0.0" },
        },
      ],
    };

    await axios.post(config.discordWebhookUrl, payload, { timeout: 5000 });
    console.log(`[DISCORD] Alert sent for user: ${user.slice(0, 8)}...`);
  }

  private async sendResendWelcomeReceipt(
    user: string,
    amount: string,
    sig: string
  ): Promise<void> {
    if (!config.resendApiKey || config.resendApiKey.startsWith("re_test_mock")) {
      console.log(`[RESEND MOCK] Skipping email delivery (Mock or Test API key configured).`);
      return;
    }

    try {
      const result = await resend.emails.send({
        from: config.notificationFromEmail,
        to: config.alertRecipientEmail,
        subject: `Grow Rewards: First Move Confirmed for ${user.slice(0, 6)}...`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
            <h2 style="color: #14f195;">Congratulations on Your First Move!</h2>
            <p>Your on-chain action has been verified and settled on Solana.</p>
            <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
              <tr>
                <td style="padding: 8px 0; color: #666;">User Wallet:</td>
                <td style="padding: 8px 0; font-weight: bold; text-align: right;">${user}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Reward Released:</td>
                <td style="padding: 8px 0; font-weight: bold; text-align: right; color: #14f195;">+${amount} SPL</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #666;">Tx Signature:</td>
                <td style="padding: 8px 0; font-size: 12px; text-align: right;">${sig.slice(0, 16)}...</td>
              </tr>
            </table>
            <p style="font-size: 13px; color: #888;">Non-custodial milestone distribution powered by Solana & Anchor.</p>
          </div>
        `,
      });
      console.log(`[RESEND] Email receipt dispatched: ${result.data?.id}`);
    } catch (error) {
      console.error("[RESEND DELIVERY FAILED]", error);
    }
  }

  public async healthCheck(): Promise<void> {
    const slot = await this.connection.getSlot("confirmed");
    console.log(`[SYSTEM OK] RPC alive. Current slot: ${slot}`);
  }
}

// Direct Execution Hook
if (require.main === module) {
  const daemon = new GrowRewardsDaemon();
  daemon.start().catch((err) => {
    console.error("[FATAL ERROR IN DAEMON]", err);
    process.exit(1);
  });
}