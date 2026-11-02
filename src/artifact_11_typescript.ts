// Add inside index.ts entrypoint
import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
    return;
  }
  if (req.url === "/metrics" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        uptimeSeconds: process.uptime(),
        memoryUsage: process.memoryUsage(),
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(process.env.PORT || 8080);