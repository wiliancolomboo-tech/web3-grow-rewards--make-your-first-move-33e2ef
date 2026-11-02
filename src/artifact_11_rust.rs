use anchor_lang::prelude::*;
use crate::state::*;
use crate::errors::GrowRewardsError;
use crate::events::ProtocolPauseToggledEvent;

#[derive(Accounts)]
pub struct EmergencyPause<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.config_bump,
        has_one = admin @ GrowRewardsError::Unauthorized
    )]
    pub config: Account<'info, GlobalConfig>,
}

pub fn handle(ctx: Context<EmergencyPause>, pause: bool) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.is_paused = pause;

    emit!(ProtocolPauseToggledEvent {
        admin: ctx.accounts.admin.key(),
        is_paused: pause,
        timestamp: Clock::get()?.unix_timestamp,
    });

    Ok(())
}