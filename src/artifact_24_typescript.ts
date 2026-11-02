// Add inside src/index.ts or standalone micro-service
import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "UP",
        service: "grow-rewards-daemon",
        timestamp: new Date().toISOString(),
        uptime_seconds: process.uptime(),
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8080, () => {
  logger.info("Healthcheck listener active on port 8080");
});