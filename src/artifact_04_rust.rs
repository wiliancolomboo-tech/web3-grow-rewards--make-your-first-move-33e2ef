use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GrwRew1111111111111111111111111111111111111");

pub const CAMPAIGN_SEED: &[u8] = b"grow_campaign";
pub const USER_TRACKER_SEED: &[u8] = b"user_tracker";
pub const REWARD_VAULT_SEED: &[u8] = b"reward_vault";

// Math Constants for Early Mover Bonus
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_MULTIPLIER_BPS: u64 = 25_000; // 2.5x Max Multiplier
pub const BASE_MULTIPLIER_BPS: u64 = 10_000; // 1.0x Base Multiplier

#[program]
pub mod grow_rewards {
    use super::*;

    /// Initialize a new "Make Your First Move" campaign
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: u64,
        base_reward_amount: u64,
        max_claimants: u32,
        action_verifier: Pubkey,
        decay_period_slots: u64,
    ) -> Result<()> {
        require!(base_reward_amount > 0, GrowError::InvalidRewardAmount);
        require!(max_claimants > 0, GrowError::InvalidMaxClaimants);
        require!(action_verifier != Pubkey::default(), GrowError::InvalidVerifier);

        let campaign = &mut ctx.accounts.campaign;
        campaign.admin = ctx.accounts.admin.key();
        campaign.campaign_id = campaign_id;
        campaign.reward_mint = ctx.accounts.reward_mint.key();
        campaign.reward_vault = ctx.accounts.reward_vault.key();
        campaign.base_reward_amount = base_reward_amount;
        campaign.max_claimants = max_claimants;
        campaign.claimants_count = 0;
        campaign.action_verifier = action_verifier;
        campaign.decay_period_slots = decay_period_slots;
        campaign.start_slot = Clock::get()?.slot;
        campaign.is_paused = false;
        campaign.vault_bump = ctx.bumps.reward_vault;
        campaign.campaign_bump = ctx.bumps.campaign;

        emit!(CampaignInitializedEvent {
            campaign_id,
            admin: campaign.admin,
            reward_mint: campaign.reward_mint,
            base_reward_amount,
            max_claimants,
        });

        Ok(())
    }

    /// Claim the "First Move" reward with cryptographic attestation
    pub fn claim_first_move(
        ctx: Context<ClaimFirstMove>,
        action_signature: [u8; 64],
        action_timestamp: i64,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let tracker = &mut ctx.accounts.user_tracker;
        let clock = Clock::get()?;

        // Safety validations
        require!(!campaign.is_paused, GrowError::CampaignPaused);
        require!(campaign.claimants_count < campaign.max_claimants, GrowError::CampaignCapReached);
        require!(!tracker.has_claimed, GrowError::AlreadyClaimedFirstMove);
        require!(
            clock.unix_timestamp - action_timestamp < 3600, // 1 hour validity threshold
            GrowError::AttestationExpired
        );

        // Verify off-chain verifier authority signature message payload:
        // Hash: SHA256(user_pubkey || campaign_id || action_timestamp)
        let hash_data = [
            ctx.accounts.user.key().as_ref(),
            &campaign.campaign_id.to_le_bytes(),
            &action_timestamp.to_le_bytes(),
        ].concat();
        let expected_hash = anchor_lang::solana_program::hash::hash(&hash_data);

        // Security requirement: Ensure signature is verified against campaign.action_verifier
        // In this implementation, the action_verifier signature is verified off-chain and authorized by authority account
        require_keys_eq!(
            ctx.accounts.verifier_authority.key(),
            campaign.action_verifier,
            GrowError::UnauthorizedVerifier
        );

        // Compute Early Mover Multiplier
        let current_slot = clock.slot;
        let slots_elapsed = current_slot.saturating_sub(campaign.start_slot);
        
        let multiplier_bps = if slots_elapsed >= campaign.decay_period_slots {
            BASE_MULTIPLIER_BPS
        } else {
            let decay_delta = MAX_MULTIPLIER_BPS - BASE_MULTIPLIER_BPS;
            let reduction = (decay_delta as u128 * slots_elapsed as u128)
                / (campaign.decay_period_slots as u128);
            MAX_MULTIPLIER_BPS.saturating_sub(reduction as u64)
        };

        let calculated_payout = (campaign.base_reward_amount as u128 * multiplier_bps as u128
            / BPS_DENOMINATOR as u128) as u64;

        // Ensure Vault has sufficient balance
        require!(
            ctx.accounts.reward_vault.amount >= calculated_payout,
            GrowError::VaultInsufficientFunds
        );

        // Update Tracker State
        tracker.user = ctx.accounts.user.key();
        tracker.campaign_id = campaign.campaign_id;
        tracker.has_claimed = true;
        tracker.claimed_at = clock.unix_timestamp;
        tracker.reward_payout = calculated_payout;
        tracker.multiplier_bps = multiplier_bps;
        tracker.tracker_bump = ctx.bumps.user_tracker;

        // Increment campaign counter
        campaign.claimants_count = campaign.claimants_count.checked_add(1).ok_or(GrowError::Overflow)?;

        // Execute CPI Token Transfer from Vault to User ATA
        let campaign_id_bytes = campaign.campaign_id.to_le_bytes();
        let seeds = &[
            REWARD_VAULT_SEED,
            campaign_id_bytes.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.reward_vault.to_account_info(),
                to: ctx.accounts.user_reward_account.to_account_info(),
                authority: ctx.accounts.reward_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, calculated_payout)?;

        emit!(FirstMoveClaimedEvent {
            campaign_id: campaign.campaign_id,
            user: ctx.accounts.user.key(),
            reward_payout: calculated_payout,
            multiplier_bps,
            action_hash: expected_hash.to_bytes(),
        });

        Ok(())
    }

    /// Admin Emergency Controls & Pool Management
    pub fn set_paused(ctx: Context<ManageCampaign>, is_paused: bool) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.is_paused = is_paused;
        emit!(CampaignStatusUpdatedEvent {
            campaign_id: campaign.campaign_id,
            is_paused,
        });
        Ok(())
    }

    /// Close expired campaign & withdraw remaining reserves
    pub fn close_campaign(ctx: Context<CloseCampaign>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let campaign_id_bytes = campaign.campaign_id.to_le_bytes();
        let seeds = &[
            REWARD_VAULT_SEED,
            campaign_id_bytes.as_ref(),
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let remaining_balance = ctx.accounts.reward_vault.amount;
        if remaining_balance > 0 {
            let transfer_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.reward_vault.to_account_info(),
                    to: ctx.accounts.admin_reward_account.to_account_info(),
                    authority: ctx.accounts.reward_vault.to_account_info(),
                },
                signer_seeds,
            );
            token::transfer(transfer_ctx, remaining_balance)?;
        }

        // Close the vault token account
        let close_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::CloseAccount {
                account: ctx.accounts.reward_vault.to_account_info(),
                destination: ctx.accounts.admin.to_account_info(),
                authority: ctx.accounts.reward_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::close_account(close_ctx)?;

        Ok(())
    }
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct InitializeCampaign<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = Campaign::LEN,
        seeds = [CAMPAIGN_SEED, campaign_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = admin,
        seeds = [REWARD_VAULT_SEED, campaign_id.to_le_bytes().as_ref()],
        bump,
        token::mint = reward_mint,
        token::authority = reward_vault,
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimFirstMove<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub verifier_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.campaign_bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = user,
        space = UserTracker::LEN,
        seeds = [USER_TRACKER_SEED, campaign.campaign_id.to_le_bytes().as_ref(), user.key().as_ref()],
        bump
    )]
    pub user_tracker: Account<'info, UserTracker>,

    #[account(
        mut,
        seeds = [REWARD_VAULT_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.vault_bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = campaign.reward_mint,
        token::authority = user
    )]
    pub user_reward_account: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ManageCampaign<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ GrowError::UnauthorizedAdmin,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.campaign_bump
    )]
    pub campaign: Account<'info, Campaign>,
}

#[derive(Accounts)]
pub struct CloseCampaign<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ GrowError::UnauthorizedAdmin,
        close = admin,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.campaign_bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [REWARD_VAULT_SEED, campaign.campaign_id.to_le_bytes().as_ref()],
        bump = campaign.vault_bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = campaign.reward_mint,
        token::authority = admin
    )]
    pub admin_reward_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
pub struct Campaign {
    pub admin: Pubkey,               // 32
    pub campaign_id: u64,            // 8
    pub reward_mint: Pubkey,         // 32
    pub reward_vault: Pubkey,        // 32
    pub base_reward_amount: u64,     // 8
    pub max_claimants: u32,          // 4
    pub claimants_count: u32,        // 4
    pub action_verifier: Pubkey,     // 32
    pub decay_period_slots: u64,     // 8
    pub start_slot: u64,             // 8
    pub is_paused: bool,             // 1
    pub vault_bump: u8,              // 1
    pub campaign_bump: u8,           // 1
}

impl Campaign {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 32 + 8 + 4 + 4 + 32 + 8 + 8 + 1 + 1 + 1 + 32;
}

#[account]
pub struct UserTracker {
    pub user: Pubkey,                // 32
    pub campaign_id: u64,            // 8
    pub has_claimed: bool,           // 1
    pub claimed_at: i64,             // 8
    pub reward_payout: u64,          // 8
    pub multiplier_bps: u64,         // 8
    pub tracker_bump: u8,            // 1
}

impl UserTracker {
    pub const LEN: usize = 8 + 32 + 8 + 1 + 8 + 8 + 8 + 1 + 32;
}

// -----------------------------------------------------------------------------
// EVENTS & ERRORS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitializedEvent {
    pub campaign_id: u64,
    pub admin: Pubkey,
    pub reward_mint: Pubkey,
    pub base_reward_amount: u64,
    pub max_claimants: u32,
}

#[event]
pub struct FirstMoveClaimedEvent {
    pub campaign_id: u64,
    pub user: Pubkey,
    pub reward_payout: u64,
    pub multiplier_bps: u64,
    pub action_hash: [u8; 32],
}

#[event]
pub struct CampaignStatusUpdatedEvent {
    pub campaign_id: u64,
    pub is_paused: bool,
}

#[error_code]
pub enum GrowError {
    #[msg("Reward amount must be strictly greater than zero.")]
    InvalidRewardAmount,
    #[msg("Max claimants cap must be strictly greater than zero.")]
    InvalidMaxClaimants,
    #[msg("Invalid verifier public key provided.")]
    InvalidVerifier,
    #[msg("Campaign is currently paused by administrator.")]
    CampaignPaused,
    #[msg("Campaign max claimant cap has been reached.")]
    CampaignCapReached,
    #[msg("User has already claimed their First Move reward.")]
    AlreadyClaimedFirstMove,
    #[msg("Attestation has expired; please request a fresh proof.")]
    AttestationExpired,
    #[msg("Signer is not authorized as the campaign verifier.")]
    UnauthorizedVerifier,
    #[msg("Reward vault does not hold enough tokens to fulfill reward.")]
    VaultInsufficientFunds,
    #[msg("Unauthorized administrator.")]
    UnauthorizedAdmin,
    #[msg("Arithmetic overflow encountered.")]
    Overflow,
}