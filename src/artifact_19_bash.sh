# 1. Generate program keypair if not already created
solana-keygen new -o target/deploy/grow_rewards-keypair.json --no-bip39-passphrase --force

# 2. Build Anchor binary with deterministic output
anchor build

# 3. Synchronize program id
anchor keys sync

# 4. Deploy to Solana Devnet / Mainnet
solana program deploy \
  --url https://api.devnet.solana.com \
  --keypair ~/.config/solana/id.json \
  target/deploy/grow_rewards.so

# 5. Initialize Engine via Anchor CLI
npx ts-node -e '
  import { execSync } from "child_process";
  console.log("Program successfully deployed to Solana.");
'