const http = require('http');
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'HEALTHY', protocol: 'grow_rewards', timestamp: Date.now() }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(8080);