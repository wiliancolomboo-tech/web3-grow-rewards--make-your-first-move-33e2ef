use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GrowRew111111111111111111111111111111111111");

#[program]
pub mod grow_rewards {
    use super::*;

    /// Initializes global protocol settings, fee payer, and vault authorities.
    pub fn initialize_protocol(
        ctx: Context<InitializeProtocol>,
        base_reward_amount: u64,
        cooldown_seconds: i64,
        max_multiplier_bps: u16,
    ) -> Result<()> {
        require!(base_reward_amount > 0, GrowRewardsError::InvalidRewardAmount);
        require!(max_multiplier_bps >= 10_000, GrowRewardsError::InvalidMultiplier);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.reward_mint = ctx.accounts.reward_mint.key();
        config.reward_vault = ctx.accounts.reward_vault.key();
        config.base_reward_amount = base_reward_amount;
        config.cooldown_seconds = cooldown_seconds;
        config.max_multiplier_bps = max_multiplier_bps;
        config.total_distributed = 0;
        config.total_users = 0;
        config.is_paused = false;
        config.bump = ctx.bumps.config;
        config.vault_bump = ctx.bumps.vault_authority;

        emit!(ProtocolInitializedEvent {
            authority: config.authority,
            reward_mint: config.reward_mint,
            base_reward_amount,
            cooldown_seconds,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// User creates their activation account profile on first contact.
    pub fn initialize_user(ctx: Context<InitializeUser>) -> Result<()> {
        let user_state = &mut ctx.accounts.user_state;
        let clock = Clock::get()?;

        user_state.user = ctx.accounts.user.key();
        user_state.first_move_completed = false;
        user_state.first_move_timestamp = 0;
        user_state.last_claim_timestamp = 0;
        user_state.milestone_tier = 0;
        user_state.total_actions = 0;
        user_state.total_rewards_earned = 0;
        user_state.bump = ctx.bumps.user_state;

        let config = &mut ctx.accounts.config;
        config.total_users = config.total_users.checked_add(1).ok_or(GrowRewardsError::MathOverflow)?;

        emit!(UserInitializedEvent {
            user: user_state.user,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Core instruction: "Make Your First Move".
    /// Validates eligibility, calculates action score with tier bonuses, updates state,
    /// and performs a secure PDA CPI transfer of SPL reward tokens to the user's ATA.
    pub fn execute_first_move(
        ctx: Context<ExecuteFirstMove>,
        action_weight_bps: u16,
        proof_metadata_hash: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.is_paused, GrowRewardsError::ProgramPaused);
        require!(action_weight_bps >= 10_000, GrowRewardsError::InvalidActionWeight);
        require!(action_weight_bps <= config.max_multiplier_bps, GrowRewardsError::ActionWeightExceedsLimit);

        let clock = Clock::get()?;
        let user_state = &mut ctx.accounts.user_state;

        // Anti-Sybil / Double Action check
        if user_state.first_move_completed {
            let elapsed = clock.unix_timestamp.checked_sub(user_state.last_claim_timestamp)
                .ok_or(GrowRewardsError::MathOverflow)?;
            require!(
                elapsed >= config.cooldown_seconds,
                GrowRewardsError::CooldownPeriodActive
            );
        }

        // Calculate deterministic reward payout: base * (action_weight_bps / 10_000)
        let raw_reward = (config.base_reward_amount as u128)
            .checked_mul(action_weight_bps as u128)
            .ok_or(GrowRewardsError::MathOverflow)?
            .checked_div(10_000)
            .ok_or(GrowRewardsError::MathOverflow)? as u64;

        require!(
            ctx.accounts.reward_vault.amount >= raw_reward,
            GrowRewardsError::InsufficientVaultLiquidity
        );

        // State mutations
        if !user_state.first_move_completed {
            user_state.first_move_completed = true;
            user_state.first_move_timestamp = clock.unix_timestamp;
            user_state.milestone_tier = 1;
        } else {
            user_state.milestone_tier = user_state.milestone_tier.saturating_add(1);
        }

        user_state.last_claim_timestamp = clock.unix_timestamp;
        user_state.total_actions = user_state.total_actions.checked_add(1).ok_or(GrowRewardsError::MathOverflow)?;
        user_state.total_rewards_earned = user_state.total_rewards_earned.checked_add(raw_reward).ok_or(GrowRewardsError::MathOverflow)?;

        // Global stats mutation
        let config_mut = &mut ctx.accounts.config;
        config_mut.total_distributed = config_mut.total_distributed.checked_add(raw_reward).ok_or(GrowRewardsError::MathOverflow)?;

        // Execute CPI Token Transfer from Vault Authority PDA to User Token Account
        let config_key = config_mut.key();
        let seeds = &[
            b"vault_authority".as_ref(),
            config_key.as_ref(),
            &[config_mut.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.reward_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, raw_reward)?;

        // Emit real-time log event for enterprise webhooks & indexing pipelines
        emit!(FirstMoveCompletedEvent {
            user: user_state.user,
            reward_amount: raw_reward,
            milestone_tier: user_state.milestone_tier,
            action_weight_bps,
            proof_hash: proof_metadata_hash,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Admin emergency controls: Pause/Unpause protocol.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = paused;
        emit!(ProtocolPauseStatusChanged { paused });
        Ok(())
    }

    /// Admin treasury management: Top up or withdraw excess vault reserves.
    pub fn emergency_withdraw_vault(
        ctx: Context<EmergencyWithdraw>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, GrowRewardsError::InvalidRewardAmount);
        require!(
            ctx.accounts.reward_vault.amount >= amount,
            GrowRewardsError::InsufficientVaultLiquidity
        );

        let config_key = ctx.accounts.config.key();
        let seeds = &[
            b"vault_authority".as_ref(),
            config_key.as_ref(),
            &[ctx.accounts.config.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.reward_vault.to_account_info(),
            to: ctx.accounts.destination_token_account.to_account_info(),
            authority: ctx.accounts.vault_authority.to_account_info(),
        };

        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        );

        token::transfer(cpi_ctx, amount)?;

        emit!(EmergencyWithdrawEvent {
            destination: ctx.accounts.destination_token_account.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
pub fn initialize_protocol<'info>(
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"grow_config"],
        bump
    )]
    pub config: Account<'info, Config>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = reward_mint,
        token::authority = vault_authority,
        seeds = [b"reward_vault", config.key().as_ref()],
        bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    /// CHECK: PDA used strictly as the signing authority for the token vault.
    #[account(
        seeds = [b"vault_authority", config.key().as_ref()],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub fn initialize_user<'info>(
    #[account(
        mut,
        seeds = [b"grow_config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = user,
        space = 8 + UserAccount::INIT_SPACE,
        seeds = [b"user_state", config.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub fn execute_first_move<'info>(
    #[account(
        mut,
        seeds = [b"grow_config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"user_state", config.key().as_ref(), user.key().as_ref()],
        bump = user_state.bump,
        has_one = user @ GrowRewardsError::UnauthorizedUser
    )]
    pub user_state: Account<'info, UserAccount>,

    #[account(
        mut,
        seeds = [b"reward_vault", config.key().as_ref()],
        bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    /// CHECK: Validated with seeds against program ID.
    #[account(
        seeds = [b"vault_authority", config.key().as_ref()],
        bump = config.vault_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ GrowRewardsError::InvalidTokenAccountOwner,
        constraint = user_token_account.mint == config.reward_mint @ GrowRewardsError::InvalidMint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub fn admin_only<'info>(
    #[account(
        mut,
        seeds = [b"grow_config"],
        bump = config.bump,
        has_one = authority @ GrowRewardsError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub fn emergency_withdraw<'info>(
    #[account(
        mut,
        seeds = [b"grow_config"],
        bump = config.bump,
        has_one = authority @ GrowRewardsError::UnauthorizedAdmin
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"reward_vault", config.key().as_ref()],
        bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    /// CHECK: PDA authority
    #[account(
        seeds = [b"vault_authority", config.key().as_ref()],
        bump = config.vault_bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = destination_token_account.mint == config.reward_mint @ GrowRewardsError::InvalidMint
    )]
    pub destination_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,          // 32
    pub reward_mint: Pubkey,        // 32
    pub reward_vault: Pubkey,       // 32
    pub base_reward_amount: u64,    // 8
    pub cooldown_seconds: i64,      // 8
    pub max_multiplier_bps: u16,    // 2
    pub total_distributed: u64,     // 8
    pub total_users: u64,           // 8
    pub is_paused: bool,            // 1
    pub bump: u8,                   // 1
    pub vault_bump: u8,             // 1
}

#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub user: Pubkey,               // 32
    pub first_move_completed: bool, // 1
    pub first_move_timestamp: i64,  // 8
    pub last_claim_timestamp: i64,  // 8
    pub milestone_tier: u8,         // 1
    pub total_actions: u64,         // 8
    pub total_rewards_earned: u64,  // 8
    pub bump: u8,                   // 1
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct ProtocolInitializedEvent {
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub base_reward_amount: u64,
    pub cooldown_seconds: i64,
    pub timestamp: i64,
}

#[event]
pub struct UserInitializedEvent {
    pub user: Pubkey,
    pub timestamp: i64,
}

#[event]
pub struct FirstMoveCompletedEvent {
    pub user: Pubkey,
    pub reward_amount: u64,
    pub milestone_tier: u8,
    pub action_weight_bps: u16,
    pub proof_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct ProtocolPauseStatusChanged {
    pub paused: bool,
}

#[event]
pub struct EmergencyWithdrawEvent {
    pub destination: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum GrowRewardsError {
    #[msg("Invalid reward amount specified.")]
    InvalidRewardAmount,
    #[msg("Invalid multiplier basis points (must be >= 10,000).")]
    InvalidMultiplier,
    #[msg("Action weight is less than unit (10,000 bps).")]
    InvalidActionWeight,
    #[msg("Action weight exceeds max configured multiplier.")]
    ActionWeightExceedsLimit,
    #[msg("Protocol is currently paused by admin.")]
    ProgramPaused,
    #[msg("Cooldown period active. Please wait before executing subsequent moves.")]
    CooldownPeriodActive,
    #[msg("Insufficient tokens available in protocol reward vault.")]
    InsufficientVaultLiquidity,
    #[msg("Signer does not match stored user state authority.")]
    UnauthorizedUser,
    #[msg("Signer is not authorized to execute administrative instruction.")]
    UnauthorizedAdmin,
    #[msg("Token account owner does not match signer.")]
    InvalidTokenAccountOwner,
    #[msg("Token account mint mismatch.")]
    InvalidMint,
    #[msg("Mathematical overflow occurred during computation.")]
    MathOverflow,
}