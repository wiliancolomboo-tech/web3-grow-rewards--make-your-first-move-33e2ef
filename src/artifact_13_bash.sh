# 1. Build and verify Solana Anchor program
anchor build

# 2. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/grow_rewards-keypair.json \
  target/deploy/grow_rewards.so \
  --url https://api.devnet.solana.com

# 3. Initialize Campaign via Enterprise CLI
npm run cli -- init-campaign \
  --campaign-id "first-move-launch" \
  --mint "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" \
  --reward 10000000 \
  --max-claims 1000 \
  --keypair ~/.config/solana/id.json \
  --signer "<ATTESTATION_AUTHORITY_PUBKEY>"

# 4. Spin up Off-Chain Enterprise Relay Worker
docker compose up -d --build