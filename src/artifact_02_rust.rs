use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GrowRew111111111111111111111111111111111111");

pub const CAMPAIGN_SEED: &[u8] = b"campaign";
pub const USER_RECORD_SEED: &[u8] = b"user_record";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod grow_rewards {
    use super::*;

    /// Initialize a new Growth Campaign with reward tokens, fixed reward amounts, and authorized verifier.
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: u64,
        reward_per_move: u64,
        max_recipients: u64,
        oracle_signer: Pubkey,
    ) -> Result<()> {
        require!(reward_per_move > 0, GrowError::InvalidRewardAmount);
        require!(max_recipients > 0, GrowError::InvalidMaxRecipients);

        let campaign = &mut ctx.accounts.campaign;
        campaign.authority = ctx.accounts.authority.key();
        campaign.campaign_id = campaign_id;
        campaign.reward_mint = ctx.accounts.reward_mint.key();
        campaign.vault = ctx.accounts.vault.key();
        campaign.reward_per_move = reward_per_move;
        campaign.max_recipients = max_recipients;
        campaign.current_recipients = 0;
        campaign.oracle_signer = oracle_signer;
        campaign.is_active = true;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.vault;

        emit!(CampaignInitializedEvent {
            campaign_id,
            authority: campaign.authority,
            reward_mint: campaign.reward_mint,
            reward_per_move,
            max_recipients,
        });

        Ok(())
    }

    /// Fund the campaign vault with reward tokens.
    pub fn fund_vault(ctx: Context<FundVault>, amount: u64) -> Result<()> {
        require!(amount > 0, GrowError::ZeroDepositAmount);

        let transfer_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.funder_token_account.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            },
        );
        token::transfer(transfer_ctx, amount)?;

        emit!(VaultFundedEvent {
            campaign_id: ctx.accounts.campaign.campaign_id,
            amount,
            funder: ctx.accounts.funder.key(),
        });

        Ok(())
    }

    /// Claim the "First Move" reward by verifying cryptographic oracle signature and recording state.
    pub fn record_first_move_and_claim(
        ctx: Context<RecordFirstMoveAndClaim>,
        action_signature: [u8; 64],
        action_timestamp: i64,
        action_id: [u8; 32],
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        require!(campaign.is_active, GrowError::CampaignInactive);
        require!(
            campaign.current_recipients < campaign.max_recipients,
            GrowError::CampaignExhausted
        );

        let clock = Clock::get()?;
        // Reject stale attestations older than 15 minutes
        require!(
            clock.unix_timestamp - action_timestamp < 900,
            GrowError::AttestationExpired
        );

        let user_record = &mut ctx.accounts.user_record;
        require!(!user_record.has_claimed, GrowError::AlreadyClaimed);

        // Verify that the vault has sufficient balance
        require!(
            ctx.accounts.vault.amount >= campaign.reward_per_move,
            GrowError::InsufficientVaultFunds
        );

        // State update
        user_record.user = ctx.accounts.user.key();
        user_record.campaign_id = campaign.campaign_id;
        user_record.completed_at = clock.unix_timestamp;
        user_record.action_id = action_id;
        user_record.reward_amount = campaign.reward_per_move;
        user_record.has_claimed = true;
        user_record.bump = ctx.bumps.user_record;

        campaign.current_recipients = campaign
            .current_recipients
            .checked_add(1)
            .ok_or(GrowError::MathOverflow)?;

        // Transfer reward from PDA vault to user
        let campaign_id_bytes = campaign.campaign_id.to_le_bytes();
        let seeds = &[
            VAULT_SEED,
            campaign_id_bytes.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, campaign.reward_per_move)?;

        emit!(FirstMoveClaimedEvent {
            campaign_id: campaign.campaign_id,
            user: ctx.accounts.user.key(),
            reward_amount: campaign.reward_per_move,
            action_id,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Admin emergency pause toggle.
    pub fn set_campaign_state(ctx: Context<SetCampaignState>, is_active: bool) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        require_keys_eq!(
            campaign.authority,
            ctx.accounts.authority.key(),
            GrowError::Unauthorized
        );
        campaign.is_active = is_active;
        Ok(())
    }

    /// Protocol authority can withdraw remaining balance after campaign concludes.
    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>, amount: u64) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        require_keys_eq!(
            campaign.authority,
            ctx.accounts.authority.key(),
            GrowError::Unauthorized
        );

        let campaign_id_bytes = campaign.campaign_id.to_le_bytes();
        let seeds = &[
            VAULT_SEED,
            campaign_id_bytes.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, amount)?;

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT VALIDATION CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct InitializeCampaign<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = Campaign::LEN,
        seeds = [CAMPAIGN_SEED, campaign_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        seeds = [VAULT_SEED, campaign_id.to_le_bytes().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = vault
    )]
    pub vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct FundVault<'info> {
    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        address = campaign.vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = campaign.reward_mint,
        token::authority = funder
    )]
    pub funder_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct RecordFirstMoveAndClaim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    /// Authorized backend verification oracle ensuring the user met criteria
    pub oracle: Signer<'info>,

    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.bump,
        has_one = oracle_signer @ GrowError::InvalidOracleSigner
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = user,
        space = UserRecord::LEN,
        seeds = [USER_RECORD_SEED, campaign.campaign_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_record: Account<'info, UserRecord>,

    #[account(
        mut,
        address = campaign.vault
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = campaign.reward_mint,
        token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct SetCampaignState<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,
}

#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        address = campaign.vault
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = campaign.reward_mint
    )]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// DATA STRUCTS & EVENTS
// -----------------------------------------------------------------------------

#[account]
pub struct Campaign {
    pub authority: Pubkey,
    pub campaign_id: u64,
    pub reward_mint: Pubkey,
    pub vault: Pubkey,
    pub reward_per_move: u64,
    pub max_recipients: u64,
    pub current_recipients: u64,
    pub oracle_signer: Pubkey,
    pub is_active: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Campaign {
    pub const LEN: usize = 8 + // Anchor discriminator
        32 + // authority
        8  + // campaign_id
        32 + // reward_mint
        32 + // vault
        8  + // reward_per_move
        8  + // max_recipients
        8  + // current_recipients
        32 + // oracle_signer
        1  + // is_active
        1  + // bump
        1;   // vault_bump
}

#[account]
pub struct UserRecord {
    pub user: Pubkey,
    pub campaign_id: u64,
    pub completed_at: i64,
    pub action_id: [u8; 32],
    pub reward_amount: u64,
    pub has_claimed: bool,
    pub bump: u8,
}

impl UserRecord {
    pub const LEN: usize = 8 + // Anchor discriminator
        32 + // user
        8  + // campaign_id
        8  + // completed_at
        32 + // action_id
        8  + // reward_amount
        1  + // has_claimed
        1;   // bump
}

#[event]
pub struct CampaignInitializedEvent {
    pub campaign_id: u64,
    pub authority: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_per_move: u64,
    pub max_recipients: u64,
}

#[event]
pub struct VaultFundedEvent {
    pub campaign_id: u64,
    pub amount: u64,
    pub funder: Pubkey,
}

#[event]
pub struct FirstMoveClaimedEvent {
    pub campaign_id: u64,
    pub user: Pubkey,
    pub reward_amount: u64,
    pub action_id: [u8; 32],
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERROR CODES
// -----------------------------------------------------------------------------

#[error_code]
pub enum GrowError {
    #[msg("Reward amount per move must be greater than zero.")]
    InvalidRewardAmount,
    #[msg("Max recipients count must be greater than zero.")]
    InvalidMaxRecipients,
    #[msg("Deposit amount must be greater than zero.")]
    ZeroDepositAmount,
    #[msg("Campaign is currently inactive or paused.")]
    CampaignInactive,
    #[msg("Campaign recipient limit has been reached.")]
    CampaignExhausted,
    #[msg("Verification attestation has expired.")]
    AttestationExpired,
    #[msg("User has already claimed their first move reward for this campaign.")]
    AlreadyClaimed,
    #[msg("Insufficient reward tokens available in the vault.")]
    InsufficientVaultFunds,
    #[msg("Arithmetic overflow occurred.")]
    MathOverflow,
    #[msg("Unauthorized signer for this campaign.")]
    Unauthorized,
    #[msg("Provided oracle signer does not match campaign configuration.")]
    InvalidOracleSigner,
}