use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::GrowRewardsError;
use crate::events::RewardFundedEvent;

#[derive(Accounts)]
pub struct FundRewardPool<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.config_bump,
        has_one = reward_mint @ GrowRewardsError::InvalidTokenMint
    )]
    pub config: Account<'info, GlobalConfig>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [VAULT_SEED, reward_mint.key().as_ref()],
        bump = config.vault_bump
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = funder
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handle(ctx: Context<FundRewardPool>, amount: u64) -> Result<()> {
    require!(amount > 0, GrowRewardsError::InvalidClaimAmount);

    let cpi_accounts = Transfer {
        from: ctx.accounts.funder_token_account.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.funder.to_account_info(),
    };

    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
    token::transfer(cpi_ctx, amount)?;

    ctx.accounts.vault.reload()?;

    emit!(RewardFundedEvent {
        funder: ctx.accounts.funder.key(),
        amount,
        new_vault_balance: ctx.accounts.vault.amount,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}