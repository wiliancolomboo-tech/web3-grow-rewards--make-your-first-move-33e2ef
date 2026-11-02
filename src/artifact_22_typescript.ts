import * as http from "http";
import { Connection, PublicKey } from "@solana/web3.js";
import { NotificationDispatcher } from "./services/notifications";
import * as dotenv from "dotenv";

dotenv.config();

const PORT = parseInt(process.env.PORT || "8080", 10);
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

const notifications = new NotificationDispatcher({
  resendApiKey: process.env.RESEND_API_KEY,
  resendFromEmail: process.env.RESEND_FROM_EMAIL,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
});

// Telemetry State
let lastSlotProcessed = 0;
let isHealthy = true;

const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    try {
      const slot = await connection.getSlot();
      lastSlotProcessed = slot;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "UP",
          network: "solana",
          currentSlot: slot,
          uptimeSeconds: process.uptime(),
        })
      );
    } catch (err: any) {
      isHealthy = false;
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "DEGRADED", error: err.message }));
    }
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[GrowRewards Engine] Telemetry service listening on port ${PORT}`);
  console.log(`[GrowRewards Engine] Monitoring Solana RPC: ${RPC_URL}`);
});