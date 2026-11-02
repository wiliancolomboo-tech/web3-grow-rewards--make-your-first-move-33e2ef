import http from "http";

const HEALTH_PORT = process.env.PORT || 8080;

const healthServer = http.createServer((req, res) => {
  if (req.url === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

healthServer.listen(HEALTH_PORT, () => {
  console.log(`[Health Telemetry] Listening on port ${HEALTH_PORT}`);
});