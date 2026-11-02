const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'HEALTHY',
    protocol: 'GrowRewards',
    network: process.env.ANCHOR_PROVIDER_URL ? 'Connected' : 'Unconfigured',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`[GrowRewards Engine] Healthcheck endpoint live on port ${PORT}`);
});