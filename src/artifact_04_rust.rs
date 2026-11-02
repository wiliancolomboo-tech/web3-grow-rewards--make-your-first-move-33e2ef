use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GrwRew111111111111111111111111111111111111");

#[program]
pub mod grow_rewards {
    use super::*;

    /// Initializes a new reward campaign with an isolated reward escrow vault.
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: u64,
        reward_amount_per_move: u64,
        max_allowed_claims: u64,
    ) -> Result<()> {
        require!(reward_amount_per_move > 0, GrowError::InvalidRewardAmount);
        require!(max_allowed_claims > 0, GrowError::InvalidMaxClaims);

        let campaign = &mut ctx.accounts.campaign;
        campaign.authority = ctx.accounts.authority.key();
        campaign.campaign_id = campaign_id;
        campaign.reward_mint = ctx.accounts.reward_mint.key();
        campaign.vault = ctx.accounts.vault.key();
        campaign.reward_amount_per_move = reward_amount_per_move;
        campaign.max_allowed_claims = max_allowed_claims;
        campaign.total_claims_completed = 0;
        campaign.is_active = true;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.vault;

        emit!(CampaignInitializedEvent {
            campaign: campaign.key(),
            authority: campaign.authority,
            reward_mint: campaign.reward_mint,
            reward_amount_per_move,
            max_allowed_claims,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Deposits rewards into the campaign escrow vault.
    pub fn fund_campaign_vault(ctx: Context<FundCampaignVault>, amount: u64) -> Result<()> {
        require!(amount > 0, GrowError::InvalidDepositAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.funder_token_account.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.funder.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(CampaignVaultFundedEvent {
            campaign: ctx.accounts.campaign.key(),
            funder: ctx.accounts.funder.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Primary Onboarding Instruction: "Make Your First Move"
    /// Atomically records user activation, verifies single-use PDA, and executes reward disbursement.
    pub fn make_first_move(
        ctx: Context<MakeFirstMove>,
        action_type: u8,
        referral_code: [u8; 16],
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        require!(campaign.is_active, GrowError::CampaignInactive);
        require!(
            campaign.total_claims_completed < campaign.max_allowed_claims,
            GrowError::CampaignCapacityExhausted
        );

        let vault_balance = ctx.accounts.vault.amount;
        require!(
            vault_balance >= campaign.reward_amount_per_move,
            GrowError::InsufficientVaultLiquidity
        );

        let clock = Clock::get()?;
        let user_activation = &mut ctx.accounts.user_activation;
        user_activation.user = ctx.accounts.user.key();
        user_activation.campaign = campaign.key();
        user_activation.action_type = action_type;
        user_activation.referral_code = referral_code;
        user_activation.timestamp = clock.unix_timestamp;
        user_activation.bump = ctx.bumps.user_activation;

        // Perform checked arithmetic for total claims
        campaign.total_claims_completed = campaign
            .total_claims_completed
            .checked_add(1)
            .ok_or(GrowError::ArithmeticOverflow)?;

        // Transfer reward tokens from Vault PDA to User Token Account via CPI
        let campaign_key = campaign.key();
        let seeds = &[
            b"vault",
            campaign_key.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_cpi_accounts = Transfer {
            from: ctx.accounts.vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        };
        let transfer_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_cpi_accounts,
            signer_seeds,
        );
        token::transfer(transfer_cpi_ctx, campaign.reward_amount_per_move)?;

        emit!(FirstMoveCompletedEvent {
            campaign: campaign.key(),
            user: ctx.accounts.user.key(),
            action_type,
            referral_code,
            reward_amount: campaign.reward_amount_per_move,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Emergency pause/unpause campaign functionality
    pub fn set_campaign_state(ctx: Context<SetCampaignState>, is_active: bool) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.is_active = is_active;
        emit!(CampaignStateChangedEvent {
            campaign: campaign.key(),
            is_active,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION STRUCTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub征
pub struct InitializeCampaign<'info> {
    #[account(
        init,
        payer = authority,
        space = CampaignState::LEN,
        seeds = [b"campaign", authority.key().as_ref(), &campaign_id.to_le_bytes()],
        bump
    )]
    pub campaign: Account<'info, CampaignState>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [b"vault", campaign.key().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundCampaignVault<'info> {
    #[account(
        mut,
        has_one = vault @ GrowError::InvalidVaultAccount,
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub funder: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MakeFirstMove<'info> {
    #[account(
        mut,
        has_one = vault @ GrowError::InvalidVaultAccount,
    )]
    pub campaign: Account<'info, CampaignState>,

    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        space = UserActivationState::LEN,
        seeds = [b"user_activation", campaign.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_activation: Account<'info, UserActivationState>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() @ GrowError::InvalidRecipientOwner,
        constraint = user_token_account.mint == campaign.reward_mint @ GrowError::InvalidMint
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetCampaignState<'info> {
    #[account(
        mut,
        has_one = authority @ GrowError::UnauthorizedAuthority
    )]
    pub campaign: Account<'info, CampaignState>,
    pub authority: Signer<'info>,
}

// -----------------------------------------------------------------------------
// STATE SCHEMAS
// -----------------------------------------------------------------------------

#[account]
pub struct CampaignState {
    pub authority: Pubkey,               // 32
    pub campaign_id: u64,                // 8
    pub reward_mint: Pubkey,             // 32
    pub vault: Pubkey,                   // 32
    pub reward_amount_per_move: u64,     // 8
    pub max_allowed_claims: u64,         // 8
    pub total_claims_completed: u64,     // 8
    pub is_active: bool,                 // 1
    pub bump: u8,                        // 1
    pub vault_bump: u8,                  // 1
}

impl CampaignState {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 32 + 8 + 8 + 8 + 1 + 1 + 1 + 64; // + padding
}

#[account]
pub struct UserActivationState {
    pub user: Pubkey,                    // 32
    pub campaign: Pubkey,                // 32
    pub action_type: u8,                 // 1
    pub referral_code: [u8; 16],         // 16
    pub timestamp: i64,                  // 8
    pub bump: u8,                        // 1
}

impl UserActivationState {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 16 + 8 + 1 + 32; // + padding
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitializedEvent {
    pub campaign: Pubkey,
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_amount_per_move: u64,
    pub max_allowed_claims: u64,
    pub timestamp: i64,
}

#[event]
pub struct CampaignVaultFundedEvent {
    pub campaign: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct FirstMoveCompletedEvent {
    pub campaign: Pubkey,
    pub user: Pubkey,
    pub action_type: u8,
    pub referral_code: [u8; 16],
    pub reward_amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct CampaignStateChangedEvent {
    pub campaign: Pubkey,
    pub is_active: bool,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum GrowError {
    #[msg("Reward amount per move must be greater than zero.")]
    InvalidRewardAmount,
    #[msg("Maximum allowed claims must be greater than zero.")]
    InvalidMaxClaims,
    #[msg("Deposit amount must be greater than zero.")]
    InvalidDepositAmount,
    #[msg("This campaign is currently paused or inactive.")]
    CampaignInactive,
    #[msg("Campaign max claim threshold has been reached.")]
    CampaignCapacityExhausted,
    #[msg("Campaign escrow vault has insufficient tokens to fulfill reward.")]
    InsufficientVaultLiquidity,
    #[msg("Arithmetic overflow occurred during state computation.")]
    ArithmeticOverflow,
    #[msg("Supplied vault account does not match the campaign configuration.")]
    InvalidVaultAccount,
    #[msg("User recipient token account owner must match the signing user.")]
    InvalidRecipientOwner,
    #[msg("Recipient token account mint does not match campaign reward mint.")]
    InvalidMint,
    #[msg("Only the designated campaign authority can modify this account.")]
    UnauthorizedAuthority,
}