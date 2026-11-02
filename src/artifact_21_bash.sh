# Build the Anchor program
anchor build

# Sync Program ID into lib.rs and Anchor.toml
anchor keys sync

# Deploy to Solana Devnet
solana program deploy \
  --url devnet \
  --keypair ~/.config/solana/id.json \
  target/deploy/grow_rewards.so