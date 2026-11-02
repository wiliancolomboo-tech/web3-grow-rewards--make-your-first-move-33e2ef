use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::sysvar::instructions as instructions_sysvar;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GrowRew11111111111111111111111111111111111");

pub const CAMPAIGN_SEED: &[u8] = b"campaign";
pub const USER_RECORD_SEED: &[u8] = b"user_record";
pub const VAULT_SEED: &[u8] = b"reward_vault";

#[program]
pub mod grow_rewards {
    use super::*;

    /// Initializes a new First Move incentive campaign.
    pub fn initialize_campaign(
        ctx: Context<InitializeCampaign>,
        campaign_id: String,
        reward_amount_per_user: u64,
        max_claims: u64,
        attestation_signer: Pubkey,
    ) -> Result<()> {
        require!(
            campaign_id.len() <= 32,
            GrowRewardsError::CampaignIdTooLong
        );
        require!(
            reward_amount_per_user > 0,
            GrowRewardsError::InvalidRewardAmount
        );
        require!(max_claims > 0, GrowRewardsError::InvalidMaxClaims);

        let campaign = &mut ctx.accounts.campaign;
        campaign.admin = ctx.accounts.admin.key();
        campaign.campaign_id = campaign_id.clone();
        campaign.reward_mint = ctx.accounts.reward_mint.key();
        campaign.reward_vault = ctx.accounts.reward_vault.key();
        campaign.reward_amount_per_user = reward_amount_per_user;
        campaign.max_claims = max_claims;
        campaign.total_claims = 0;
        campaign.attestation_signer = attestation_signer;
        campaign.is_active = true;
        campaign.bump = ctx.bumps.campaign;
        campaign.vault_bump = ctx.bumps.reward_vault;

        emit!(CampaignInitializedEvent {
            campaign_id,
            admin: ctx.accounts.admin.key(),
            reward_mint: ctx.accounts.reward_mint.key(),
            reward_amount: reward_amount_per_user,
            max_claims,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// Protocol or sponsor deposits rewards into the campaign vault.
    pub fn deposit_rewards(ctx: Context<DepositRewards>, amount: u64) -> Result<()> {
        require!(amount > 0, GrowRewardsError::InvalidDepositAmount);

        let cpi_accounts = Transfer {
            from: ctx.accounts.depositor_token_account.to_account_info(),
            to: ctx.accounts.reward_vault.to_account_info(),
            authority: ctx.accounts.depositor.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::transfer(cpi_ctx, amount)?;

        emit!(RewardsDepositedEvent {
            campaign_id: ctx.accounts.campaign.campaign_id.clone(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }

    /// User executes and claims their "First Move" reward with ed25519 attestation proof.
    pub fn claim_first_move(
        ctx: Context<ClaimFirstMove>,
        action_type: u8,
        nonce: u64,
        signature: [u8; 64],
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let clock = Clock::get()?;

        require!(campaign.is_active, GrowRewardsError::CampaignInactive);
        require!(
            campaign.total_claims < campaign.max_claims,
            GrowRewardsError::CampaignCapExceeded
        );

        // Verify ed25519 signature from the authorized campaign attestation authority
        // Payload layout: [user_pubkey (32), campaign_id (32 bytes padded), action_type (1), nonce (8)]
        let mut expected_message = Vec::with_capacity(73);
        expected_message.extend_from_slice(ctx.accounts.user.key.as_ref());
        let mut campaign_id_bytes = [0u8; 32];
        let bytes = campaign.campaign_id.as_bytes();
        let len = bytes.len().min(32);
        campaign_id_bytes[..len].copy_from_slice(&bytes[..len]);
        expected_message.extend_from_slice(&campaign_id_bytes);
        expected_message.push(action_type);
        expected_message.extend_from_slice(&nonce.to_le_bytes());

        verify_ed25519_signature(
            &ctx.accounts.ix_sysvar,
            &campaign.attestation_signer,
            &expected_message,
            &signature,
        )?;

        // Ensure vault has sufficient balance
        let reward_amount = campaign.reward_amount_per_user;
        require!(
            ctx.accounts.reward_vault.amount >= reward_amount,
            GrowRewardsError::InsufficientVaultBalance
        );

        // Record User Claim
        let user_record = &mut ctx.accounts.user_record;
        user_record.user = ctx.accounts.user.key();
        user_record.campaign_id = campaign.campaign_id.clone();
        user_record.claimed_at = clock.unix_timestamp;
        user_record.reward_amount = reward_amount;
        user_record.action_type = action_type;
        user_record.bump = ctx.bumps.user_record;

        campaign.total_claims = campaign
            .total_claims
            .checked_add(1)
            .ok_or(GrowRewardsError::MathOverflow)?;

        // CPI transfer reward to user
        let campaign_id_slice = campaign.campaign_id.as_bytes();
        let seeds = &[
            VAULT_SEED,
            campaign_id_slice,
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = Transfer {
            from: ctx.accounts.reward_vault.to_account_info(),
            to: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.reward_vault.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
        token::transfer(cpi_ctx, reward_amount)?;

        emit!(FirstMoveClaimedEvent {
            campaign_id: campaign.campaign_id.clone(),
            user: ctx.accounts.user.key(),
            reward_amount,
            action_type,
            claim_index: campaign.total_claims,
            timestamp: clock.unix_timestamp,
        });

        Ok(())
    }

    /// Admin updates campaign configuration or status (pause/resume).
    pub fn set_campaign_status(
        ctx: Context<ManageCampaign>,
        is_active: bool,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        campaign.is_active = is_active;
        emit!(CampaignStatusUpdatedEvent {
            campaign_id: campaign.campaign_id.clone(),
            is_active,
            timestamp: Clock::get()?.unix_timestamp,
        });
        Ok(())
    }

    /// Admin can close an exhausted or finished campaign and reclaim residual funds.
    pub fn close_campaign(ctx: Context<CloseCampaign>) -> Result<()> {
        let campaign = &ctx.accounts.campaign;
        let residual_amount = ctx.accounts.reward_vault.amount;

        if residual_amount > 0 {
            let campaign_id_slice = campaign.campaign_id.as_bytes();
            let seeds = &[
                VAULT_SEED,
                campaign_id_slice,
                &[campaign.vault_bump],
            ];
            let signer_seeds = &[&seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.reward_vault.to_account_info(),
                to: ctx.accounts.admin_token_account.to_account_info(),
                authority: ctx.accounts.reward_vault.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);
            token::transfer(cpi_ctx, residual_amount)?;
        }

        // Close SPL vault account
        let campaign_id_slice = campaign.campaign_id.as_bytes();
        let seeds = &[
            VAULT_SEED,
            campaign_id_slice,
            &[campaign.vault_bump],
        ];
        let signer_seeds = &[&seeds[..]];

        let close_accounts = token::CloseAccount {
            account: ctx.accounts.reward_vault.to_account_info(),
            destination: ctx.accounts.admin.to_account_info(),
            authority: ctx.accounts.reward_vault.to_account_info(),
        };
        let close_cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            close_accounts,
            signer_seeds,
        );
        token::close_account(close_cpi_ctx)?;

        emit!(CampaignClosedEvent {
            campaign_id: campaign.campaign_id.clone(),
            reclaimed_amount: residual_amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
}

/// Helper function to verify that an ed25519 signature verification instruction
/// was executed immediately prior in the atomic transaction instruction introspector.
pub fn verify_ed25519_signature(
    ix_sysvar: &AccountInfo,
    expected_signer: &Pubkey,
    expected_message: &[u8],
    expected_sig: &[u8; 64],
) -> Result<()> {
    let current_ix_idx = instructions_sysvar::load_current_index_checked(ix_sysvar)?;
    require!(current_ix_idx > 0, GrowRewardsError::MissingSignatureVerification);

    let prior_ix: Instruction =
        instructions_sysvar::load_instruction_at_checked((current_ix_idx - 1) as usize, ix_sysvar)?;

    require!(
        prior_ix.program_id == ed25519_program::ID,
        GrowRewardsError::InvalidVerificationProgram
    );

    // Layout of Ed25519 instruction data:
    // Header (16 bytes):
    // num_signatures: u8 (offset 0)
    // padding: u8 (offset 1)
    // signature_offset: u16 (offset 2)
    // signature_instruction_index: u16 (offset 4)
    // public_key_offset: u16 (offset 6)
    // public_key_instruction_index: u16 (offset 8)
    // message_data_offset: u16 (offset 10)
    // message_data_size: u16 (offset 12)
    // message_instruction_index: u16 (offset 14)
    let data = prior_ix.data;
    require!(data.len() >= 16, GrowRewardsError::MalformedSignatureInstruction);

    let num_signatures = data[0];
    require!(num_signatures == 1, GrowRewardsError::MalformedSignatureInstruction);

    let sig_offset = u16::from_le_bytes([data[2], data[3]]) as usize;
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let msg_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_size = u16::from_le_bytes([data[12], data[13]]) as usize;

    require!(
        data.len() >= pubkey_offset + 32,
        GrowRewardsError::MalformedSignatureInstruction
    );
    require!(
        data.len() >= sig_offset + 64,
        GrowRewardsError::MalformedSignatureInstruction
    );
    require!(
        data.len() >= msg_offset + msg_size,
        GrowRewardsError::MalformedSignatureInstruction
    );

    let extracted_pubkey = &data[pubkey_offset..pubkey_offset + 32];
    let extracted_sig = &data[sig_offset..sig_offset + 64];
    let extracted_msg = &data[msg_offset..msg_offset + msg_size];

    require!(
        extracted_pubkey == expected_signer.as_ref(),
        GrowRewardsError::UnauthorizedAttestationSigner
    );
    require!(
        extracted_sig == expected_sig,
        GrowRewardsError::SignatureMismatch
    );
    require!(
        extracted_msg == expected_message,
        GrowRewardsError::MessageMismatch
    );

    Ok(())
}

// -----------------------------------------------------------------------------
// ACCOUNT CONTEXTS
// -----------------------------------------------------------------------------

#[derive(Accounts)]
#[instruction(campaign_id: String)]
pub self struct InitializeCampaign<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    pub reward_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = Campaign::LEN,
        seeds = [CAMPAIGN_SEED, campaign_id.as_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, campaign_id.as_bytes()],
        bump,
        token::mint = reward_mint,
        token::authority = reward_vault
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositRewards<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,

    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.vault_bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = depositor_token_account.mint == campaign.reward_mint @ GrowRewardsError::MismatchedMint,
        constraint = depositor_token_account.owner == depositor.key() @ GrowRewardsError::UnauthorizedAccountOwner
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ClaimFirstMove<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        init,
        payer = user,
        space = UserFirstMoveRecord::LEN,
        seeds = [USER_RECORD_SEED, campaign.campaign_id.as_bytes(), user.key().as_ref()],
        bump
    )]
    pub user_record: Account<'info, UserFirstMoveRecord>,

    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.vault_bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = reward_mint,
        associated_token::authority = user
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    pub reward_mint: Account<'info, Mint>,

    /// CHECK: Native Solana Instruction Introspection Sysvar
    #[account(address = instructions_sysvar::ID)]
    pub ix_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ManageCampaign<'info> {
    #[account(
        mut,
        constraint = campaign.admin == admin.key() @ GrowRewardsError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,
}

#[derive(Accounts)]
pub struct CloseCampaign<'info> {
    #[account(
        mut,
        constraint = campaign.admin == admin.key() @ GrowRewardsError::UnauthorizedAdmin
    )]
    pub admin: Signer<'info>,

    #[account(
        mut,
        close = admin,
        seeds = [CAMPAIGN_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.bump
    )]
    pub campaign: Account<'info, Campaign>,

    #[account(
        mut,
        seeds = [VAULT_SEED, campaign.campaign_id.as_bytes()],
        bump = campaign.vault_bump
    )]
    pub reward_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_token_account.mint == campaign.reward_mint @ GrowRewardsError::MismatchedMint,
        constraint = admin_token_account.owner == admin.key() @ GrowRewardsError::UnauthorizedAccountOwner
    )]
    pub admin_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

// -----------------------------------------------------------------------------
// STATE STRUCTS
// -----------------------------------------------------------------------------

#[account]
pub struct Campaign {
    pub admin: Pubkey,
    pub campaign_id: String,
    pub reward_mint: Pubkey,
    pub reward_vault: Pubkey,
    pub reward_amount_per_user: u64,
    pub max_claims: u64,
    pub total_claims: u64,
    pub attestation_signer: Pubkey,
    pub is_active: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

impl Campaign {
    // 8 (discriminator) + 32 (admin) + (4 + 32) (campaign_id) + 32 (mint) + 32 (vault)
    // + 8 (reward_amount) + 8 (max_claims) + 8 (total_claims) + 32 (attestation_signer)
    // + 1 (is_active) + 1 (bump) + 1 (vault_bump) + 32 (reserved space)
    pub const LEN: usize = 8 + 32 + 36 + 32 + 32 + 8 + 8 + 8 + 32 + 1 + 1 + 1 + 32;
}

#[account]
pub struct UserFirstMoveRecord {
    pub user: Pubkey,
    pub campaign_id: String,
    pub claimed_at: i64,
    pub reward_amount: u64,
    pub action_type: u8,
    pub bump: u8,
}

impl UserFirstMoveRecord {
    // 8 (discriminator) + 32 (user) + (4 + 32) (campaign_id) + 8 (claimed_at)
    // + 8 (reward_amount) + 1 (action_type) + 1 (bump) + 16 (reserved)
    pub const LEN: usize = 8 + 32 + 36 + 8 + 8 + 1 + 1 + 16;
}

// -----------------------------------------------------------------------------
// EVENTS
// -----------------------------------------------------------------------------

#[event]
pub struct CampaignInitializedEvent {
    pub campaign_id: String,
    pub admin: Pubkey,
    pub reward_mint: Pubkey,
    pub reward_amount: u64,
    pub max_claims: u64,
    pub timestamp: i64,
}

#[event]
pub struct RewardsDepositedEvent {
    pub campaign_id: String,
    pub depositor: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct FirstMoveClaimedEvent {
    pub campaign_id: String,
    pub user: Pubkey,
    pub reward_amount: u64,
    pub action_type: u8,
    pub claim_index: u64,
    pub timestamp: i64,
}

#[event]
pub struct CampaignStatusUpdatedEvent {
    pub campaign_id: String,
    pub is_active: bool,
    pub timestamp: i64,
}

#[event]
pub struct CampaignClosedEvent {
    pub campaign_id: String,
    pub reclaimed_amount: u64,
    pub timestamp: i64,
}

// -----------------------------------------------------------------------------
// ERRORS
// -----------------------------------------------------------------------------

#[error_code]
pub enum GrowRewardsError {
    #[msg("Campaign ID exceeds 32 bytes.")]
    CampaignIdTooLong,
    #[msg("Reward amount per user must be greater than zero.")]
    InvalidRewardAmount,
    #[msg("Max claims must be greater than zero.")]
    InvalidMaxClaims,
    #[msg("Deposit amount must be greater than zero.")]
    InvalidDepositAmount,
    #[msg("Campaign is currently inactive or paused.")]
    CampaignInactive,
    #[msg("Campaign claim limit has been reached.")]
    CampaignCapExceeded,
    #[msg("Vault has insufficient balance to reward user.")]
    InsufficientVaultBalance,
    #[msg("Mismatched SPL token mint.")]
    MismatchedMint,
    #[msg("Unauthorized account owner.")]
    UnauthorizedAccountOwner,
    #[msg("Caller is not authorized to administrate this campaign.")]
    UnauthorizedAdmin,
    #[msg("Missing Ed25519 signature instruction verification immediately before claim.")]
    MissingSignatureVerification,
    #[msg("Preceding instruction is not the Solana Ed25519 native program.")]
    InvalidVerificationProgram,
    #[msg("Malformed Ed25519 signature payload header.")]
    MalformedSignatureInstruction,
    #[msg("Attestation signer does not match authorized campaign signer.")]
    UnauthorizedAttestationSigner,
    #[msg("Signature mismatch in Ed25519 instruction.")]
    SignatureMismatch,
    #[msg("Message payload does not match expected claim schema.")]
    MessageMismatch,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}