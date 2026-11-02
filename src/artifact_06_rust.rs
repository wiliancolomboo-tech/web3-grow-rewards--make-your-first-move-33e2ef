use anchor_lang::prelude::*;

#[event]
pub struct InitializedEvent {
    pub admin: Pubkey,
    pub oracle_authority: Pubkey,
    pub reward_mint: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct RewardFundedEvent {
    pub funder: Pubkey,
    pub amount: u64,
    pub new_vault_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardClaimedEvent {
    pub user: Pubkey,
    pub milestone_id: u8,
    pub amount: u64,
    pub nonce: u64,
    pub user_total_claimed: u64,
    pub timestamp: i64,
}

#[event]
pub struct ProtocolPauseToggledEvent {
    pub admin: Pubkey,
    pub is_paused: bool,
    pub timestamp: i64,
}