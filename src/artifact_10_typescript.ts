import http from "http";

const server = http.createServer((req, res) => {
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(process.env.PORT || 8080);