use anchor_lang::prelude::*;

pub const CONFIG_SEED: &[u8] = b"global-config";
pub const VAULT_SEED: &[u8] = b"reward-vault";
pub const USER_PROGRESS_SEED: &[u8] = b"user-progress";

#[account]
pub struct GlobalConfig {
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub reward_mint: Pubkey,
    pub vault_bump: u8,
    pub config_bump: u8,
    pub is_paused: bool,
    pub total_distributed: u64,
    pub total_users_activated: u64,
}

impl GlobalConfig {
    pub const LEN: usize = 8 + // discriminator
        32 + // admin
        32 + // oracle_authority
        32 + // reward_mint
        1 +  // vault_bump
        1 +  // config_bump
        1 +  // is_paused
        8 +  // total_distributed
        8;   // total_users_activated
}

#[account]
pub struct UserProgress {
    pub user: Pubkey,
    pub claimed_milestone_mask: u32,
    pub total_rewards_received: u64,
    pub last_claim_timestamp: i64,
    pub last_nonce: u64,
    pub bump: u8,
}

impl UserProgress {
    pub const LEN: usize = 8 + // discriminator
        32 + // user
        4 +  // claimed_milestone_mask (up to 32 discrete first move milestones)
        8 +  // total_rewards_received
        8 +  // last_claim_timestamp
        8 +  // last_nonce
        1;   // bump
}