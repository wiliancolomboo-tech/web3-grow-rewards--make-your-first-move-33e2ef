# 1. Build Smart Contract
anchor build

# 2. Synchronize Program ID (Deterministic deploy key)
solana address -k target/deploy/grow_rewards-keypair.json
anchor keys sync

# 3. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --program-id target/deploy/grow_rewards-keypair.json \
  target/deploy/grow_rewards.so \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/id.json

# 4. Run automated test suite against local-testnet validator
anchor test