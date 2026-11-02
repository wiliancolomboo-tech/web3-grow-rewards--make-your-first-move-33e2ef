use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::state::*;
use crate::events::InitializedEvent;

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Oracle authority verifying off-chain milestones
    pub oracle_authority: UncheckedAccount<'info>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = GlobalConfig::LEN,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, reward_mint.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handle(ctx: Context<Initialize>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = ctx.accounts.admin.key();
    config.oracle_authority = ctx.accounts.oracle_authority.key();
    config.reward_mint = ctx.accounts.reward_mint.key();
    config.vault_bump = ctx.bumps.vault;
    config.config_bump = ctx.bumps.config;
    config.is_paused = false;
    config.total_distributed = 0;
    config.total_users_activated = 0;

    emit!(InitializedEvent {
        admin: config.admin,
        oracle_authority: config.oracle_authority,
        reward_mint: config.reward_mint,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}