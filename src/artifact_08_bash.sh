# 1. Build and verify deterministic ELF binary
anchor build

# 2. Deploy Program to Solana Devnet / Mainnet-Beta
solana program deploy \
  --program-id target/deploy/grow_rewards-keypair.json \
  target/deploy/grow_rewards.so \
  --url https://api.devnet.solana.com

# 3. Synchronize IDL to the cluster for trustless verification
anchor idl init \
  --filepath target/idl/grow_rewards.json \
  GrwRew111111111111111111111111111111111111 \
  --provider.cluster devnet