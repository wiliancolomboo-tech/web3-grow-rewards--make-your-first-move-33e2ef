import * as https from "https";

export interface NotificationConfig {
  resendApiKey?: string;
  resendFromEmail?: string;
  slackWebhookUrl?: string;
}

export class NotificationDispatcher {
  constructor(private config: NotificationConfig) {}

  public async sendMilestoneEmail(toEmail: string, milestoneName: string, rewardAmount: string): Promise<boolean> {
    if (!this.config.resendApiKey || !this.config.resendFromEmail) {
      console.log(`[NotificationDispatcher] Resend credentials not set. Skipping email to ${toEmail}`);
      return false;
    }

    const payload = JSON.stringify({
      from: this.config.resendFromEmail,
      to: [toEmail],
      subject: `🏆 Solana Milestone Achieved: ${milestoneName}!`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h1 style="color: #10b981; margin-bottom: 12px;">You Made Your First Move!</h1>
          <p style="font-size: 16px; color: #334155;">Congratulations! Your on-chain activation on Solana has been confirmed.</p>
          <div style="background-color: #f8fafc; border-left: 4px solid #10b981; padding: 16px; margin: 20px 0;">
            <p style="margin: 0; font-weight: bold; color: #0f172a;">Milestone: ${milestoneName}</p>
            <p style="margin: 4px 0 0 0; color: #64748b;">Reward Credited: <strong>${rewardAmount} Tokens</strong></p>
          </div>
          <p style="font-size: 14px; color: #64748b;">The SPL tokens have been deposited directly into your connected Solana wallet address.</p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
          <p style="font-size: 12px; color: #94a3b8;">Powered by Grow Rewards Engine • Solana High-Performance Infrastructure</p>
        </div>
      `,
    });

    return new Promise((resolve) => {
      const req = https.request(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.resendApiKey}`,
            "Content-Length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          resolve(res.statusCode !== null && res.statusCode >= 200 && res.statusCode < 300);
        }
      );
      req.on("error", (e) => {
        console.error("[NotificationDispatcher] Error dispatching Resend email:", e);
        resolve(false);
      });
      req.write(payload);
      req.end();
    });
  }

  public async sendSlackAlert(userPubkey: string, milestoneId: number, rewardAmount: string, txSignature: string): Promise<boolean> {
    if (!this.config.slackWebhookUrl) {
      console.log(`[NotificationDispatcher] Slack webhook not set. Skipping Slack broadcast.`);
      return false;
    }

    const payload = JSON.stringify({
      text: `🚀 *New First Move Activation Claimed!*`,
      attachments: [
        {
          color: "#10b981",
          fields: [
            { title: "User Address", value: `\`${userPubkey}\``, short: false },
            { title: "Milestone ID", value: `${milestoneId}`, short: true },
            { title: "Reward Distributed", value: `${rewardAmount}`, short: true },
            { title: "Solana Tx", value: `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`, short: false }
          ],
          footer: "Grow Rewards Autonomous Daemon",
          ts: Math.floor(Date.now() / 1000)
        }
      ]
    });

    return new Promise((resolve) => {
      try {
        const url = new URL(this.config.slackWebhookUrl!);
        const req = https.request(
          url,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            },
          },
          (res) => {
            resolve(res.statusCode !== null && res.statusCode >= 200 && res.statusCode < 300);
          }
        );
        req.on("error", (e) => {
          console.error("[NotificationDispatcher] Slack alert error:", e);
          resolve(false);
        });
        req.write(payload);
        req.end();
      } catch (err) {
        console.error("[NotificationDispatcher] Slack URL parsing failed:", err);
        resolve(false);
      }
    });
  }
}