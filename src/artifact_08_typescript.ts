import { Command } from "commander";
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import { GrowRewardsClient } from "../client/growClient";

const program = new Command();

program
  .name("grow-rewards-cli")
  .description("Enterprise CLI for managing Solana Grow Rewards Campaigns")
  .version("1.0.0");

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

program
  .command("init-campaign")
  .requiredOption("-c, --campaign-id <id>", "Campaign Unique ID (max 32 chars)")
  .requiredOption("-m, --mint <pubkey>", "SPL Token Mint Pubkey")
  .requiredOption("-r, --reward <amount>", "Reward per user in base units")
  .requiredOption("-max, --max-claims <count>", "Max claims allowed")
  .requiredOption("-k, --keypair <path>", "Admin Keypair path")
  .requiredOption("-s, --signer <pubkey>", "Attestation Oracle Public Key")
  .action(async (options) => {
    const admin = loadKeypair(options.keypair);
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const idl = JSON.parse(fs.readFileSync("./target/idl/grow_rewards.json", "utf8"));
    const anchorProgram = new anchor.Program(idl, provider);
    const client = new GrowRewardsClient(anchorProgram, provider);

    const [campaignPDA] = client.getCampaignPDA(options.campaignId);
    const [vaultPDA] = client.getVaultPDA(options.campaignId);

    console.log(`Initializing Campaign: ${options.campaignId}`);
    const tx = await anchorProgram.methods
      .initializeCampaign(
        options.campaignId,
        new anchor.BN(options.reward),
        new anchor.BN(options.maxClaims),
        new PublicKey(options.signer)
      )
      .accounts({
        admin: admin.publicKey,
        rewardMint: new PublicKey(options.mint),
        campaign: campaignPDA,
        rewardVault: vaultPDA,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();

    console.log(`✅ Campaign Created! Signature: ${tx}`);
    console.log(`Campaign PDA: ${campaignPDA.toBase58()}`);
    console.log(`Reward Vault: ${vaultPDA.toBase58()}`);
  });

program.parse(process.argv);