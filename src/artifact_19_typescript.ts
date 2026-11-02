import http from "http";
import { GrowRewardsWatcher } from "./eventWatcher";
import { CONFIG } from "./config";

// Initialize HTTP healthcheck server for Docker / K8s probes
const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/ready") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "UP", timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(CONFIG.PORT, () => {
  console.log(`[HTTP] Healthcheck server listening on port ${CONFIG.PORT}`);
  const watcher = new GrowRewardsWatcher();
  watcher.start();
});