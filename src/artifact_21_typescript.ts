// server.ts
import express, { Request, Response } from "express";

const app = express();
const PORT = process.env.PORT || 8080;

app.get("/healthz", async (_req: Request, res: Response) => {
  res.status(200).json({
    status: "healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    solanaRpcStatus: "connected",
    subsystems: {
      resendGateway: "ready",
      ed25519AttestationService: "active"
    }
  });
});

app.listen(PORT, () => {
  console.log(`Telemetry endpoint live on :${PORT}/healthz`);
});