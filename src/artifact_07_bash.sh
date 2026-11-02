# 1. Build Solana Program
anchor build

# 2. Deploy to Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
anchor deploy --program-name grow_rewards

# 3. Synchronize Program ID
anchor keys sync