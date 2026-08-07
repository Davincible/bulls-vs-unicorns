use anchor_lang::prelude::*;
declare_id!("BuLLsArena11111111111111111111111111111111");

#[program]
pub mod bulls_arena {
    use super::*;
    pub fn ping(_ctx: Context<Ping>) -> Result<()> { Ok(()) }
}

#[derive(Accounts)]
pub struct Ping<'info> { pub payer: Signer<'info> }
