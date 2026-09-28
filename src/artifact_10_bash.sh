# 1. Clone repository and install dependencies
git clone https://github.com/grow-rewards/make-your-first-move.git
cd make-your-first-move
npm install

# 2. Build the Anchor Smart Contract
anchor build

# 3. Deploy to Solana Devnet
solana config set --url devnet
solana airdrop 2
anchor deploy --provider.cluster devnet

# 4. Run the Full Test Matrix
anchor test

# 5. Launch Enterprise Automation Agent CLI
docker-compose run grow-agent execute-claim \
  --campaign-id 9001 \
  --user-keypair ./keys/user.json \
  --verifier-keypair ./keys/verifier.json \
  --reward-mint 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU \
  --user-email "solana_builder@enterprise.com"