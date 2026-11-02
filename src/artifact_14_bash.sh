# Set network to Devnet or Mainnet-beta
solana config set --url https://api.devnet.solana.com

# Build program
anchor build

# Deploy to Solana
solana program deploy target/deploy/grow_rewards.so --program-id GrowRwds11111111111111111111111111111111111