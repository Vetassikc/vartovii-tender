//! Tender-bound state and authenticated callback for the B2 local slice.
//!
//! The program owns the tender snapshot. Supplier transactions authenticate a
//! deterministic slot and an Ed25519 precompile message before storing only
//! ciphertexts, encryption public keys and nonces. Queueing has no bid input;
//! it can only read the frozen account snapshot.

use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;
use solana_program::hash::hash;

const COMP_DEF_OFFSET_ALLOCATE: u32 = comp_def_offset("allocate");
const TENDER_SEED: &[u8] = b"tender";
const SUPPLIER_COUNT: usize = 3;
const STATE_OPEN: u8 = 0;
const STATE_FROZEN: u8 = 1;
const STATE_QUEUED: u8 = 2;
const STATE_FINALIZED: u8 = 3;
const POLICY_VERSION: u32 = 1;
const COMPUTATION_VERSION: u32 = 1;

declare_id!("5ZmtkAKZ3Da8PeoeCcC8S7Wcec8VthjomvzvihUKzK1W");

#[arcium_program]
pub mod tender {
    use super::*;

    pub fn init_allocate_comp_def(ctx: Context<InitAllocateCompDef>) -> Result<()> {
        init_computation_def(ctx.accounts, None)?;
        Ok(())
    }

    pub fn create_tender(
        ctx: Context<CreateTender>,
        tender_id: [u8; 16],
        invited: [Pubkey; SUPPLIER_COUNT],
        deadline: i64,
    ) -> Result<()> {
        require!(
            invited[0] != invited[1]
                && invited[0] != invited[2]
                && invited[1] != invited[2],
            ErrorCode::InvitedSuppliersNotDistinct
        );
        require!(deadline > Clock::get()?.unix_timestamp, ErrorCode::InvalidDeadline);

        let tender = &mut ctx.accounts.tender;
        tender.bump = ctx.bumps.tender;
        tender.creator = ctx.accounts.creator.key();
        tender.tender_id = tender_id;
        tender.deadline = deadline;
        tender.policy_version = POLICY_VERSION;
        tender.computation_version = COMPUTATION_VERSION;
        tender.invited = invited;
        tender.state = STATE_OPEN;
        tender.bid_count = 0;
        tender.bids = [BidRecord::empty(); SUPPLIER_COUNT];
        tender.commitment = [0; 32];
        tender.computation_offset = 0;
        tender.computation_account = Pubkey::default();
        tender.result_status = 255;
        tender.lot_0_supplier = 3;
        tender.lot_1_supplier = 3;
        tender.lot_0_price = 0;
        tender.lot_1_price = 0;
        tender.total = 0;
        tender.applied_at = 0;
        Ok(())
    }

    pub fn submit_bid(
        ctx: Context<SubmitBid>,
        _tender_id: [u8; 16],
        slot: u8,
        ciphertexts: [[u8; 32]; 3],
        encryption_pubkey: [u8; 32],
        nonce: u128,
        supplier_signature: [u8; 64],
    ) -> Result<()> {
        require!((slot as usize) < SUPPLIER_COUNT, ErrorCode::InvalidSupplierSlot);
        let tender = &mut ctx.accounts.tender;
        require!(tender.state == STATE_OPEN, ErrorCode::TenderNotOpen);
        require!(
            tender.invited.iter().any(|supplier| supplier == &ctx.accounts.supplier.key()),
            ErrorCode::SupplierNotInvited
        );
        require!(
            tender.invited[slot as usize] == ctx.accounts.supplier.key(),
            ErrorCode::SupplierSlotMismatch
        );
        require!(
            Clock::get()?.unix_timestamp < tender.deadline,
            ErrorCode::DeadlinePassed
        );
        require!(!tender.bids[slot as usize].present, ErrorCode::DuplicateBid);

        let message = bid_message(
            tender,
            slot,
            ciphertexts,
            encryption_pubkey,
            nonce,
        );
        verify_ed25519_instruction(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &ctx.accounts.supplier.key(),
            &supplier_signature,
            &message,
        )?;

        tender.bids[slot as usize] = BidRecord {
            present: true,
            ciphertexts,
            encryption_pubkey,
            nonce,
        };
        tender.bid_count = tender
            .bid_count
            .checked_add(1)
            .ok_or(ErrorCode::BidCountOverflow)?;
        Ok(())
    }

    pub fn freeze_tender(ctx: Context<FreezeTender>, _tender_id: [u8; 16]) -> Result<()> {
        let tender = &mut ctx.accounts.tender;
        require!(tender.state == STATE_OPEN, ErrorCode::AlreadyFrozen);
        require!(tender.bid_count == SUPPLIER_COUNT as u8, ErrorCode::IncompleteBidSet);
        require!(
            tender.bids.iter().all(|bid| bid.present),
            ErrorCode::IncompleteBidSet
        );

        tender.commitment = tender_commitment(tender);
        tender.state = STATE_FROZEN;
        Ok(())
    }

    /// Queue from the program-owned frozen snapshot. There are deliberately no
    /// ciphertext parameters on this instruction, so a caller cannot replace a
    /// bid while queueing.
    pub fn queue_tender(
        ctx: Context<QueueTender>,
        _tender_id: [u8; 16],
        computation_offset: u64,
    ) -> Result<()> {
        let tender_key = ctx.accounts.tender.key();
        let args = {
            let tender = &mut ctx.accounts.tender;
            require_keys_eq!(tender.creator, ctx.accounts.payer.key(), ErrorCode::InvalidCreator);
            if tender.state == STATE_QUEUED {
                return Err(ErrorCode::TenderAlreadyQueued.into());
            }
            require!(tender.state == STATE_FROZEN, ErrorCode::TenderNotFrozen);
            require!(computation_offset != 0, ErrorCode::InvalidComputationOffset);

            let mut args = ArgBuilder::new();
            for bid in tender.bids.iter() {
                args = args
                    .x25519_pubkey(bid.encryption_pubkey)
                    .plaintext_u128(bid.nonce)
                    .encrypted_u64(bid.ciphertexts[0])
                    .encrypted_u64(bid.ciphertexts[1])
                    .encrypted_u8(bid.ciphertexts[2]);
            }

            tender.computation_offset = computation_offset;
            tender.computation_account = ctx.accounts.computation_account.key();
            tender.state = STATE_QUEUED;
            args.build()
        };
        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        queue_computation(
            ctx.accounts,
            computation_offset,
            args,
            vec![AllocateCallback::callback_ix(
                computation_offset,
                &ctx.accounts.mxe_account,
                &[CallbackAccount {
                    pubkey: tender_key,
                    is_writable: true,
                }],
            )?],
            1,
            0,
            0,
        )?;
        Ok(())
    }

    #[arcium_callback(encrypted_ix = "allocate")]
    pub fn allocate_callback(
        ctx: Context<AllocateCallback>,
        output: SignedComputationOutputs<AllocateOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(AllocateOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let tender = &mut ctx.accounts.tender;
        require!(tender.state == STATE_QUEUED, ErrorCode::ResultAlreadyApplied);
        require!(
            tender.computation_account == ctx.accounts.computation_account.key(),
            ErrorCode::WrongComputationAccount
        );

        tender.result_status = o.field_0;
        tender.lot_0_supplier = o.field_1;
        tender.lot_1_supplier = o.field_2;
        tender.lot_0_price = o.field_3;
        tender.lot_1_price = o.field_4;
        tender.total = o.field_5;
        tender.applied_at = Clock::get()?.unix_timestamp;
        tender.state = STATE_FINALIZED;

        emit!(AllocationAppliedEvent {
            tender: tender.key(),
            commitment: tender.commitment,
            computation_offset: tender.computation_offset,
            status: tender.result_status,
            lot_0_supplier: tender.lot_0_supplier,
            lot_1_supplier: tender.lot_1_supplier,
            lot_0_price: tender.lot_0_price,
            lot_1_price: tender.lot_1_price,
            total: tender.total,
        });
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct BidRecord {
    pub present: bool,
    pub ciphertexts: [[u8; 32]; 3],
    pub encryption_pubkey: [u8; 32],
    pub nonce: u128,
}

impl BidRecord {
    pub fn empty() -> Self {
        Self {
            present: false,
            ciphertexts: [[0; 32]; 3],
            encryption_pubkey: [0; 32],
            nonce: 0,
        }
    }
}

#[account]
pub struct Tender {
    pub bump: u8,
    pub creator: Pubkey,
    pub tender_id: [u8; 16],
    pub deadline: i64,
    pub policy_version: u32,
    pub computation_version: u32,
    pub invited: [Pubkey; SUPPLIER_COUNT],
    pub state: u8,
    pub bid_count: u8,
    pub bids: [BidRecord; SUPPLIER_COUNT],
    pub commitment: [u8; 32],
    pub computation_offset: u64,
    pub computation_account: Pubkey,
    pub result_status: u8,
    pub lot_0_supplier: u8,
    pub lot_1_supplier: u8,
    pub lot_0_price: u64,
    pub lot_1_price: u64,
    pub total: u64,
    pub applied_at: i64,
}

#[derive(Accounts)]
#[instruction(tender_id: [u8; 16])]
pub struct CreateTender<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + 1024,
        seeds = [TENDER_SEED, tender_id.as_ref()],
        bump
    )]
    pub tender: Account<'info, Tender>,
    #[account(mut)]
    pub creator: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(_tender_id: [u8; 16])]
pub struct SubmitBid<'info> {
    #[account(
        mut,
        seeds = [TENDER_SEED, _tender_id.as_ref()],
        bump = tender.bump
    )]
    pub tender: Account<'info, Tender>,
    pub supplier: Signer<'info>,
    #[account(address = arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: the instruction sysvar is parsed for the immediately preceding
    /// Ed25519 precompile instruction.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(_tender_id: [u8; 16])]
pub struct FreezeTender<'info> {
    #[account(
        mut,
        has_one = creator,
        seeds = [TENDER_SEED, _tender_id.as_ref()],
        bump = tender.bump
    )]
    pub tender: Account<'info, Tender>,
    pub creator: Signer<'info>,
}

#[queue_computation_accounts("allocate", payer)]
#[derive(Accounts)]
#[instruction(_tender_id: [u8; 16], computation_offset: u64)]
pub struct QueueTender<'info> {
    #[account(
        mut,
        seeds = [TENDER_SEED, _tender_id.as_ref()],
        bump = tender.bump
    )]
    pub tender: Box<Account<'info, Tender>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed,
        space = 9,
        payer = payer,
        seeds = [&SIGN_PDA_SEED],
        bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut, address = derive_mempool_pda!(mxe_account))]
    /// CHECK: checked by the Arcium program.
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account))]
    /// CHECK: checked by the Arcium program.
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account))]
    /// CHECK: checked by the Arcium program and stored in the tender snapshot.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ALLOCATE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(mut, address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("allocate")]
#[derive(Accounts)]
pub struct AllocateCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ALLOCATE))]
    pub comp_def_account: Box<Account<'info, ComputationDefinitionAccount>>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    /// CHECK: verified by `verify_output` and the tender equality constraint.
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(address = ::arcium_anchor::solana_instructions_sysvar::ID)]
    /// CHECK: checked by the callback account constraint.
    pub instructions_sysvar: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = tender.state == STATE_QUEUED @ ErrorCode::ResultAlreadyApplied,
        constraint = tender.computation_account == computation_account.key() @ ErrorCode::WrongComputationAccount
    )]
    pub tender: Box<Account<'info, Tender>>,
}

#[init_computation_definition_accounts("allocate", payer)]
#[derive(Accounts)]
pub struct InitAllocateCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: checked by the Arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: checked by the Arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct AllocationAppliedEvent {
    pub tender: Pubkey,
    pub commitment: [u8; 32],
    pub computation_offset: u64,
    pub status: u8,
    pub lot_0_supplier: u8,
    pub lot_1_supplier: u8,
    pub lot_0_price: u64,
    pub lot_1_price: u64,
    pub total: u64,
}

fn bid_message(
    tender: &Tender,
    slot: u8,
    ciphertexts: [[u8; 32]; 3],
    encryption_pubkey: [u8; 32],
    nonce: u128,
) -> Vec<u8> {
    let mut message = Vec::with_capacity(32 + 16 + 1 + 8 + 4 + 4 + 96 + 32 + 16);
    message.extend_from_slice(&crate::ID.to_bytes());
    message.extend_from_slice(&tender.tender_id);
    message.push(slot);
    message.extend_from_slice(&tender.deadline.to_le_bytes());
    message.extend_from_slice(&tender.policy_version.to_le_bytes());
    message.extend_from_slice(&tender.computation_version.to_le_bytes());
    for ciphertext in ciphertexts {
        message.extend_from_slice(&ciphertext);
    }
    message.extend_from_slice(&encryption_pubkey);
    message.extend_from_slice(&nonce.to_le_bytes());
    message
}

/// The deadline gates bid admission only. A complete set admitted before the
/// deadline may be frozen afterwards. The invited array binds each slot, so a
/// supplier public key is not repeated in each bid segment of this digest.
fn tender_commitment(tender: &Tender) -> [u8; 32] {
    let mut body = Vec::with_capacity(512);
    body.extend_from_slice(b"vartovii-b2-tender-commitment-v1");
    body.extend_from_slice(&crate::ID.to_bytes());
    body.extend_from_slice(&tender.tender_id);
    for supplier in tender.invited {
        body.extend_from_slice(&supplier.to_bytes());
    }
    body.extend_from_slice(&tender.deadline.to_le_bytes());
    body.extend_from_slice(&tender.policy_version.to_le_bytes());
    body.extend_from_slice(&tender.computation_version.to_le_bytes());
    for (slot, bid) in tender.bids.iter().enumerate() {
        body.push(slot as u8);
        for ciphertext in bid.ciphertexts {
            body.extend_from_slice(&ciphertext);
        }
        body.extend_from_slice(&bid.encryption_pubkey);
        body.extend_from_slice(&bid.nonce.to_le_bytes());
    }
    hash(&body).to_bytes()
}

fn verify_ed25519_instruction(
    instructions_sysvar: &AccountInfo,
    expected_pubkey: &Pubkey,
    expected_signature: &[u8; 64],
    expected_message: &[u8],
) -> Result<()> {
    let sysvar_data = instructions_sysvar.data.borrow();
    require!(sysvar_data.len() >= 4, ErrorCode::SignatureInstructionMissing);
    let current_index = u16::from_le_bytes([
        sysvar_data[sysvar_data.len() - 2],
        sysvar_data[sysvar_data.len() - 1],
    ]) as usize;
    require!(current_index > 0, ErrorCode::SignatureInstructionMissing);
    let instruction_count = read_sysvar_u16(&sysvar_data, 0)?;
    let target_index = current_index - 1;
    require!(target_index < instruction_count, ErrorCode::SignatureInstructionMissing);
    let offset_position = 2usize
        .checked_add(target_index.checked_mul(2).ok_or(ErrorCode::SignatureInstructionMissing)?)
        .ok_or(ErrorCode::SignatureInstructionMissing)?;
    let instruction_start = read_sysvar_u16(&sysvar_data, offset_position)?;
    let mut cursor = instruction_start;
    let account_count = read_sysvar_u16(&sysvar_data, cursor)?;
    cursor = cursor
        .checked_add(2 + account_count.checked_mul(33).ok_or(ErrorCode::SignatureInstructionMissing)?)
        .ok_or(ErrorCode::SignatureInstructionMissing)?;
    let program_bytes = read_sysvar_slice(&sysvar_data, cursor, 32)?;
    let program_id = Pubkey::new_from_array(
        program_bytes
            .try_into()
            .map_err(|_| error!(ErrorCode::SignatureInstructionMissing))?,
    );
    require_keys_eq!(
        program_id,
        pubkey!("Ed25519SigVerify111111111111111111111111111"),
        ErrorCode::SignatureInstructionWrongProgram
    );
    cursor = cursor
        .checked_add(32)
        .ok_or(ErrorCode::SignatureInstructionMissing)?;
    let data_length = read_sysvar_u16(&sysvar_data, cursor)?;
    cursor = cursor
        .checked_add(2)
        .ok_or(ErrorCode::SignatureInstructionMissing)?;
    let data = read_sysvar_slice(&sysvar_data, cursor, data_length)?;
    require!(data.len() >= 16 && data[0] == 1, ErrorCode::InvalidSupplierSignature);

    let read_u16 = |offset: usize| -> usize {
        u16::from_le_bytes([data[offset], data[offset + 1]]) as usize
    };
    let signature_offset = read_u16(2);
    let signature_instruction_index = read_u16(4);
    let public_key_offset = read_u16(6);
    let public_key_instruction_index = read_u16(8);
    let message_offset = read_u16(10);
    let message_size = read_u16(12);
    let message_instruction_index = read_u16(14);
    require!(
        signature_instruction_index == usize::from(u16::MAX)
            && public_key_instruction_index == usize::from(u16::MAX)
            && message_instruction_index == usize::from(u16::MAX),
        ErrorCode::InvalidSupplierSignature
    );
    require!(
        signature_offset.checked_add(64).is_some()
            && public_key_offset.checked_add(32).is_some()
            && message_offset.checked_add(message_size).is_some()
            && signature_offset + 64 <= data.len()
            && public_key_offset + 32 <= data.len()
            && message_offset + message_size <= data.len(),
        ErrorCode::InvalidSupplierSignature
    );
    require!(
        &data[signature_offset..signature_offset + 64] == expected_signature,
        ErrorCode::InvalidSupplierSignature
    );
    require!(
        &data[public_key_offset..public_key_offset + 32] == expected_pubkey.as_ref(),
        ErrorCode::InvalidSupplierSignature
    );
    require!(
        &data[message_offset..message_offset + message_size] == expected_message,
        ErrorCode::InvalidSupplierSignature
    );
    Ok(())
}

fn read_sysvar_u16(data: &[u8], offset: usize) -> Result<usize> {
    let bytes = read_sysvar_slice(data, offset, 2)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]) as usize)
}

fn read_sysvar_slice<'a>(data: &'a [u8], offset: usize, length: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(length)
        .ok_or(ErrorCode::SignatureInstructionMissing)?;
    require!(end <= data.len(), ErrorCode::SignatureInstructionMissing);
    Ok(&data[offset..end])
}

#[error_code]
pub enum ErrorCode {
    #[msg("The invited suppliers must be distinct")]
    InvitedSuppliersNotDistinct,
    #[msg("The deadline must be in the future")]
    InvalidDeadline,
    #[msg("The tender is not open")]
    TenderNotOpen,
    #[msg("The supplier is not invited")]
    SupplierNotInvited,
    #[msg("The supplier does not match the deterministic slot")]
    SupplierSlotMismatch,
    #[msg("The supplier slot is invalid")]
    InvalidSupplierSlot,
    #[msg("The bid deadline has passed")]
    DeadlinePassed,
    #[msg("This supplier slot already has a bid")]
    DuplicateBid,
    #[msg("The supplier signature is invalid")]
    InvalidSupplierSignature,
    #[msg("The Ed25519 instruction is missing")]
    SignatureInstructionMissing,
    #[msg("The preceding instruction is not Ed25519 verification")]
    SignatureInstructionWrongProgram,
    #[msg("The bid count overflowed")]
    BidCountOverflow,
    #[msg("The tender is already frozen or finalized")]
    AlreadyFrozen,
    #[msg("All three supplier bids are required")]
    IncompleteBidSet,
    #[msg("The tender must be frozen before queueing")]
    TenderNotFrozen,
    #[msg("The tender already has a queued computation")]
    TenderAlreadyQueued,
    #[msg("The computation offset is invalid")]
    InvalidComputationOffset,
    #[msg("The computation account does not match the tender")]
    WrongComputationAccount,
    #[msg("Only the tender creator may queue the computation")]
    InvalidCreator,
    #[msg("The computation was aborted; the tender remains pending")]
    AbortedComputation,
    #[msg("The result has already been applied")]
    ResultAlreadyApplied,
    #[msg("The cluster is not set")]
    ClusterNotSet,
}
