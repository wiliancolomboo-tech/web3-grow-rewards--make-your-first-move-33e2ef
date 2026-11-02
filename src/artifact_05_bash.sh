# 1. Clone repository and install dependencies
git clone https://github.com/grow-rewards/solana-first-move.git
cd solana-first-move
npm install

# 2. Build Anchor smart contract
anchor build

# 3. Configure local devnet or testnet deployment
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 4. Initialize Campaign and Seed Rewards
ts-node scripts/init-campaign.ts --campaignId 1 --reward 50000000 --max 10000