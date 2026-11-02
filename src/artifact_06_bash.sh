# 1. Clone repository and install dependencies
git clone https://github.com/grow-rewards/first-move-solana.git
cd first-move-solana
npm install

# 2. Build Anchor BPF binaries
anchor build

# 3. Synchronize Program ID and keys
solana-keygen new -o deploy-keypair.json --no-bip39-passphrase --force
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet-Beta
solana config set --url https://api.devnet.solana.com
anchor deploy --provider.cluster devnet

# 5. Run full test verification suite against local-validator or devnet
anchor test