import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import axios from "axios";
import { Resend } from "resend";

interface NotificationConfig {
  resendApiKey: string;
  resendFromEmail: string;
  slackWebhookUrl: string;
  solanaRpcUrl: string;
  programId: string;
}

export class EnterpriseEventRelay {
  private connection: Connection;
  private resend: Resend;
  private slackWebhookUrl: string;
  private programId: PublicKey;

  constructor(config: NotificationConfig) {
    this.connection = new Connection(config.solanaRpcUrl, "confirmed");
    this.resend = new Resend(config.resendApiKey);
    this.slackWebhookUrl = config.slackWebhookUrl;
    this.programId = new PublicKey(config.programId);
  }

  public async startListener(program: anchor.Program) {
    console.log(`[Relay Engine] Listening to events on Program ${this.programId.toBase58()}...`);

    program.addEventListener("FirstMoveClaimedEvent", async (event: any, slot: number) => {
      console.log(`[Event Detected] First Move Claimed:`, event);

      const user = event.user.toBase58();
      const campaignId = event.campaignId;
      const rewardAmount = event.rewardAmount.toString();
      const actionType = event.actionType;
      const claimIndex = event.claimIndex.toString();

      await Promise.allSettled([
        this.notifySlack({
          campaignId,
          user,
          rewardAmount,
          actionType,
          claimIndex,
          slot,
        }),
        this.sendUserReceiptEmail({
          userPubkey: user,
          campaignId,
          rewardAmount,
          actionType,
        }),
      ]);
    });
  }

  private async notifySlack(data: {
    campaignId: string;
    user: string;
    rewardAmount: string;
    actionType: number;
    claimIndex: string;
    slot: number;
  }) {
    if (!this.slackWebhookUrl) return;

    const payload = {
      text: `🚀 *New First Move Claimed on Solana!*`,
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🌟 Grow Rewards: First Move Activated!",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Campaign:* \`${data.campaignId}\`` },
            { type: "mrkdwn", text: `*User:* \`${data.user.slice(0, 4)}...${data.user.slice(-4)}\`` },
            { type: "mrkdwn", text: `*Reward Paid:* *${(Number(data.rewardAmount) / 1e6).toFixed(2)} tokens*` },
            { type: "mrkdwn", text: `*Claim Number:* #${data.claimIndex}` },
          ],
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Action Code: *Type ${data.actionType}* | Slot: *${data.slot}* | Explorer: <https://solscan.io/account/${data.user}|View User>`,
            },
          ],
        },
      ],
    };

    try {
      await axios.post(this.slackWebhookUrl, payload, { timeout: 5000 });
      console.log(`[Slack Dispatch] Broadcasted notification for user ${data.user}`);
    } catch (err: any) {
      console.error(`[Slack Dispatch Error] ${err.message}`);
    }
  }

  private async sendUserReceiptEmail(data: {
    userPubkey: string;
    campaignId: string;
    rewardAmount: string;
    actionType: number;
  }) {
    // If user has an associated email registered in protocol off-chain CRM
    const recipient = process.env.TEST_RECEIPT_EMAIL || "rewards-growth@example.com";
    try {
      await this.resend.emails.send({
        from: "Grow Rewards <onboarding@grow-rewards.xyz>",
        to: [recipient],
        subject: `🎉 Congratulations on Making Your First Move in ${data.campaignId}!`,
        html: `
          <div style="font-family: sans-serif; padding: 24px; color: #111;">
            <h1 style="color: #6366f1;">Welcome to the Ecosystem!</h1>
            <p>Your on-chain First Move was verified and processed on Solana.</p>
            <div style="background: #f4f4f5; padding: 16px; border-radius: 8px;">
              <p><strong>Wallet:</strong> <code>${data.userPubkey}</code></p>
              <p><strong>Campaign:</strong> ${data.campaignId}</p>
              <p><strong>Reward Disbursed:</strong> ${(Number(data.rewardAmount) / 1e6).toFixed(2)} Tokens</p>
            </div>
            <p style="margin-top: 20px;">Keep exploring to unlock next-tier milestone rewards!</p>
          </div>
        `,
      });
      console.log(`[Resend Dispatch] Receipt successfully emailed to ${recipient}`);
    } catch (err: any) {
      console.error(`[Resend Dispatch Error] ${err.message}`);
    }
  }
}