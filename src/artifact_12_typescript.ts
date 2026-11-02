import express, { Request, Response } from "express";
import { EnterpriseEventRelay } from "./relayService";
import * as anchor from "@coral-xyz/anchor";
import * as fs from "fs";

const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

const config = {
  resendApiKey: process.env.RESEND_API_KEY || "dummy",
  resendFromEmail: process.env.RESEND_FROM_EMAIL || "onboarding@grow-rewards.xyz",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "GrowRew11111111111111111111111111111111111",
};

const relay = new EnterpriseEventRelay(config);

// Telemetry & Liveness Endpoint
app.get("/health", async (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    rpcConnected: config.solanaRpcUrl,
    programId: config.programId,
  });
});

app.listen(port, () => {
  console.log(`[Grow Rewards Relay] Telemetry live on port ${port}`);
});