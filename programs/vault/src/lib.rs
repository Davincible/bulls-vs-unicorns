//! Bulls ⚔ Unicorns — pooled custody vault.
//!
//! Design: ONE pooled token vault per side (BULL / UWU). Per-player balances are tracked
//! OFF-CHAIN (Postgres) by the engine; this program only moves real tokens on deposit and
//! on authority-cosigned withdraw, and takes the 0.2% deploy fee. Cheap: a handful of
//! on-chain accounts total, not one per user.
//!
//! Trust model (v1): withdrawals require the `settlement_authority` (the engine's key, which
//! knows the ledger) to co-sign — it can only release funds TO the requesting user, never to
//! itself. Upgrade path to full trustlessness: replace cosigned withdraw with a Merkle-root
//! balance commitment posted in `settle_round` + on-chain proof in `withdraw`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("VauLt1111111111111111111111111111111111111"); // replaced at deploy

pub const FEE_BPS_MAX: u16 = 500; // 5% hard cap safety
pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_VAULT: &[u8] = b"vault";

#[program]
pub mod bulls_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= FEE_BPS_MAX, VaultError::FeeTooHigh);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.settlement_authority = ctx.accounts.settlement_authority.key();
        c.bull_mint = ctx.accounts.bull_mint.key();
        c.uwu_mint = ctx.accounts.uwu_mint.key();
        c.bull_vault = ctx.accounts.bull_vault.key();
        c.uwu_vault = ctx.accounts.uwu_vault.key();
        c.fee_bull = ctx.accounts.fee_bull.key();
        c.fee_uwu = ctx.accounts.fee_uwu.key();
        c.fee_bps = fee_bps;
        c.paused = false;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// User deposits `amount` of a side's token. 0.2% (fee_bps) is skimmed to the house fee
    /// account; the net is credited to the player's OFF-CHAIN balance by the engine (which
    /// watches the emitted `Deposited` event).
    pub fn deposit(ctx: Context<Deposit>, side: Side, amount: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, VaultError::Paused);
        require!(amount > 0, VaultError::ZeroAmount);
        ctx.accounts.assert_side(side)?;

        let fee = (amount as u128 * c.fee_bps as u128 / 10_000) as u64;
        let net = amount.checked_sub(fee).ok_or(VaultError::MathError)?;

        // user -> pooled vault (net)
        token::transfer(ctx.accounts.xfer_to_vault(), net)?;
        // user -> house fee account (fee)
        if fee > 0 {
            token::transfer(ctx.accounts.xfer_to_fee(), fee)?;
        }

        emit!(Deposited {
            player: ctx.accounts.player.key(),
            side,
            gross: amount,
            fee,
            net,
        });
        Ok(())
    }

    /// Authority-cosigned withdrawal: the settlement authority attests the player is owed
    /// `amount` (their off-chain balance covers it). Program signs the pooled vault to release
    /// funds ONLY to the player. `nonce` is recorded off-chain by the authority to prevent replay.
    pub fn withdraw(ctx: Context<Withdraw>, side: Side, amount: u64, nonce: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, VaultError::Paused);
        require!(amount > 0, VaultError::ZeroAmount);
        ctx.accounts.assert_side(side)?;

        let seeds: &[&[u8]] = &[SEED_CONFIG, &[c.bump]];
        let signer: &[&[&[u8]]] = &[seeds];
        token::transfer(ctx.accounts.xfer_to_player().with_signer(signer), amount)?;

        emit!(Withdrawn {
            player: ctx.accounts.player.key(),
            side,
            amount,
            nonce,
        });
        Ok(())
    }

    // ---- admin ----
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }
    pub fn set_settlement_authority(ctx: Context<AdminOnly>, new_auth: Pubkey) -> Result<()> {
        ctx.accounts.config.settlement_authority = new_auth;
        Ok(())
    }
    pub fn set_fee_bps(ctx: Context<AdminOnly>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= FEE_BPS_MAX, VaultError::FeeTooHigh);
        ctx.accounts.config.fee_bps = fee_bps;
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Side { Bull, Uwu }

#[account]
pub struct Config {
    pub admin: Pubkey,
    pub settlement_authority: Pubkey,
    pub bull_mint: Pubkey,
    pub uwu_mint: Pubkey,
    pub bull_vault: Pubkey,
    pub uwu_vault: Pubkey,
    pub fee_bull: Pubkey,
    pub fee_uwu: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
}
impl Config { pub const LEN: usize = 8 + 32*8 + 2 + 1 + 1; }

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)] pub admin: Signer<'info>,
    /// CHECK: stored as settlement authority
    pub settlement_authority: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = Config::LEN, seeds = [SEED_CONFIG], bump)]
    pub config: Account<'info, Config>,
    pub bull_mint: Account<'info, Mint>,
    pub uwu_mint: Account<'info, Mint>,
    #[account(init, payer = admin, seeds = [SEED_VAULT, bull_mint.key().as_ref()], bump,
        token::mint = bull_mint, token::authority = config)]
    pub bull_vault: Account<'info, TokenAccount>,
    #[account(init, payer = admin, seeds = [SEED_VAULT, uwu_mint.key().as_ref()], bump,
        token::mint = uwu_mint, token::authority = config)]
    pub uwu_vault: Account<'info, TokenAccount>,
    #[account(token::mint = bull_mint)] pub fee_bull: Account<'info, TokenAccount>,
    #[account(token::mint = uwu_mint)] pub fee_uwu: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)] pub config: Account<'info, Config>,
    #[account(mut)] pub player: Signer<'info>,
    #[account(mut, token::authority = player)] pub player_token: Account<'info, TokenAccount>,
    #[account(mut)] pub vault: Account<'info, TokenAccount>,
    #[account(mut)] pub fee_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
impl<'info> Deposit<'info> {
    fn assert_side(&self, side: Side) -> Result<()> {
        let (v, f) = match side { Side::Bull => (self.config.bull_vault, self.config.fee_bull),
                                  Side::Uwu  => (self.config.uwu_vault,  self.config.fee_uwu) };
        require_keys_eq!(self.vault.key(), v, VaultError::WrongVault);
        require_keys_eq!(self.fee_account.key(), f, VaultError::WrongVault);
        Ok(())
    }
    fn xfer_to_vault(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(self.token_program.to_account_info(), Transfer {
            from: self.player_token.to_account_info(), to: self.vault.to_account_info(),
            authority: self.player.to_account_info() })
    }
    fn xfer_to_fee(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(self.token_program.to_account_info(), Transfer {
            from: self.player_token.to_account_info(), to: self.fee_account.to_account_info(),
            authority: self.player.to_account_info() })
    }
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)] pub config: Account<'info, Config>,
    #[account(address = config.settlement_authority @ VaultError::NotAuthority)]
    pub settlement_authority: Signer<'info>,
    /// CHECK: recipient; funds only ever go here
    #[account(mut)] pub player: UncheckedAccount<'info>,
    #[account(mut, token::authority = player)] pub player_token: Account<'info, TokenAccount>,
    #[account(mut)] pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
impl<'info> Withdraw<'info> {
    fn assert_side(&self, side: Side) -> Result<()> {
        let v = match side { Side::Bull => self.config.bull_vault, Side::Uwu => self.config.uwu_vault };
        require_keys_eq!(self.vault.key(), v, VaultError::WrongVault);
        Ok(())
    }
    fn xfer_to_player(&self) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(self.token_program.to_account_info(), Transfer {
            from: self.vault.to_account_info(), to: self.player_token.to_account_info(),
            authority: self.config.to_account_info() })
    }
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ VaultError::NotAdmin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[event] pub struct Deposited { pub player: Pubkey, pub side: Side, pub gross: u64, pub fee: u64, pub net: u64 }
#[event] pub struct Withdrawn { pub player: Pubkey, pub side: Side, pub amount: u64, pub nonce: u64 }

#[error_code]
pub enum VaultError {
    #[msg("fee too high")] FeeTooHigh,
    #[msg("paused")] Paused,
    #[msg("zero amount")] ZeroAmount,
    #[msg("math error")] MathError,
    #[msg("wrong vault/fee account for side")] WrongVault,
    #[msg("not settlement authority")] NotAuthority,
    #[msg("not admin")] NotAdmin,
}
