use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("GrowRwds111111111111111111111111111111111111");

#[program]
pub mod grow_rewards {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        instructions::initialize::handle(ctx)
    }

    pub fn fund_reward_pool(ctx: Context<FundRewardPool>, amount: u64) -> Result<()> {
        instructions::fund_reward_pool::handle(ctx, amount)
    }

    pub fn verify_and_claim_reward(
        ctx: Context<VerifyAndClaimReward>,
        milestone_id: u8,
        reward_amount: u64,
        nonce: u64,
        deadline: i64,
    ) -> Result<()> {
        instructions::verify_and_claim_reward::handle(ctx, milestone_id, reward_amount, nonce, deadline)
    }

    pub fn emergency_pause(ctx: Context<EmergencyPause>, pause: bool) -> Result<()> {
        instructions::emergency_pause::handle(ctx, pause)
    }
}