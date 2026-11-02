# Build Solana program artifacts
anchor build

# Obtain program authority keypair and program ID
solana address -k target/deploy/grow_rewards-keypair.json

# Deploy to Devnet / Mainnet
solana program deploy \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/id.json \
  target/deploy/grow_rewards.so