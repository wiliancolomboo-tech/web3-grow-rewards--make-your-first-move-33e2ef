use anchor_lang::prelude::*;
use anchor_lang::solana_program::ed25519_program;
use anchor_lang::solana_program::sysvar::instructions as instructions_sysvar;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use crate::state::*;
use crate::errors::GrowRewardsError;
use crate::events::RewardClaimedEvent;

#[derive(Accounts)]
pub struct VerifyAndClaimReward<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
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
        init_if_needed,
        payer = user,
        space = UserProgress::LEN,
        seeds = [USER_PROGRESS_SEED, user.key().as_ref()],
        bump
    )]
    pub user_progress: Account<'info, UserProgress>,

    #[account(
        mut,
        token::mint = reward_mint,
        token::authority = user
    )]
    pub user_reward_account: Account<'info, TokenAccount>,

    /// CHECK: Instructions sysvar for ed25519 pre-instruction introspection
    #[account(address = instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle(
    ctx: Context<VerifyAndClaimReward>,
    milestone_id: u8,
    reward_amount: u64,
    nonce: u64,
    deadline: i64,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.is_paused, GrowRewardsError::ProtocolPaused);

    let current_timestamp = Clock::get()?.unix_timestamp;
    require!(current_timestamp <= deadline, GrowRewardsError::VoucherExpired);
    require!(reward_amount > 0, GrowRewardsError::InvalidClaimAmount);
    require!(ctx.accounts.vault.amount >= reward_amount, GrowRewardsError::InsufficientVaultBalance);

    let user_progress = &mut ctx.accounts.user_progress;
    
    // Check if this specific milestone bit (0-31) has already been claimed
    let milestone_mask_bit = 1u32.checked_shl(milestone_id as u32).ok_or(GrowRewardsError::MathOverflow)?;
    require!(
        (user_progress.claimed_milestone_mask & milestone_mask_bit) == 0,
        GrowRewardsError::MilestoneAlreadyClaimed
    );
    require!(nonce > user_progress.last_nonce, GrowRewardsError::Unauthorized);

    // Verify Off-Chain Oracle Ed25519 Instruction directly preceding this instruction
    verify_ed25519_instruction(
        &ctx.accounts.instructions.to_account_info(),
        &config.oracle_authority.to_bytes(),
        &ctx.accounts.user.key().to_bytes(),
        milestone_id,
        reward_amount,
        nonce,
        deadline,
    )?;

    // Update User and Global State
    let is_first_activation = user_progress.claimed_milestone_mask == 0;
    user_progress.user = ctx.accounts.user.key();
    user_progress.claimed_milestone_mask |= milestone_mask_bit;
    user_progress.total_rewards_received = user_progress
        .total_rewards_received
        .checked_add(reward_amount)
        .ok_or(GrowRewardsError::MathOverflow)?;
    user_progress.last_claim_timestamp = current_timestamp;
    user_progress.last_nonce = nonce;
    user_progress.bump = ctx.bumps.user_progress;

    config.total_distributed = config
        .total_distributed
        .checked_add(reward_amount)
        .ok_or(GrowRewardsError::MathOverflow)?;

    if is_first_activation {
        config.total_users_activated = config
            .total_users_activated
            .checked_add(1)
            .ok_or(GrowRewardsError::MathOverflow)?;
    }

    // Execute Token Transfer via CPI from Vault PDA
    let reward_mint_key = config.reward_mint;
    let seeds = &[
        VAULT_SEED,
        reward_mint_key.as_ref(),
        &[config.vault_bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.user_reward_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::transfer(cpi_ctx, reward_amount)?;

    emit!(RewardClaimedEvent {
        user: ctx.accounts.user.key(),
        milestone_id,
        amount: reward_amount,
        nonce,
        user_total_claimed: user_progress.total_rewards_received,
        timestamp: current_timestamp,
    });

    Ok(())
}

fn verify_ed25519_instruction(
    instructions_sysvar: &AccountInfo,
    expected_oracle_pubkey: &[u8; 32],
    user_pubkey: &[u8; 32],
    milestone_id: u8,
    amount: u64,
    nonce: u64,
    deadline: i64,
) -> Result<()> {
    let current_index = instructions_sysvar::load_current_index_checked(instructions_sysvar)? as usize;
    require!(current_index > 0, GrowRewardsError::InvalidOracleSignature);

    let prior_ix = instructions_sysvar::load_instruction_at_checked(current_index - 1, instructions_sysvar)?;
    require!(prior_ix.program_id == ed25519_program::ID, GrowRewardsError::InvalidOracleSignature);

    // Build the deterministic payload message: [user(32) || milestone(1) || amount(8) || nonce(8) || deadline(8)]
    let mut expected_message = Vec::with_capacity(32 + 1 + 8 + 8 + 8);
    expected_message.extend_from_slice(user_pubkey);
    expected_message.push(milestone_id);
    expected_message.extend_from_slice(&amount.to_le_bytes());
    expected_message.extend_from_slice(&nonce.to_le_bytes());
    expected_message.extend_from_slice(&deadline.to_le_bytes());

    // Ed25519 instruction data layout validation:
    // Byte 0: num_signatures (should be 1)
    // Byte 2..16: offsets header
    let data = &prior_ix.data;
    require!(data.len() >= 16 + 64 + 32 + expected_message.len(), GrowRewardsError::InvalidOracleSignature);

    // Read pubkey and verify it matches the oracle
    let pubkey_offset = u16::from_le_bytes([data[6], data[7]]) as usize;
    let pubkey_extracted = &data[pubkey_offset..pubkey_offset + 32];
    require!(pubkey_extracted == expected_oracle_pubkey, GrowRewardsError::InvalidOracleSignature);

    // Read message data and verify match
    let message_data_offset = u16::from_le_bytes([data[10], data[11]]) as usize;
    let message_data_size = u16::from_le_bytes([data[8], data[9]]) as usize;
    let message_extracted = &data[message_data_offset..message_data_offset + message_data_size];
    require!(message_extracted == expected_message.as_slice(), GrowRewardsError::InvalidOracleSignature);

    Ok(())
}