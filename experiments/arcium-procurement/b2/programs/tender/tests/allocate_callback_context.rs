use std::{
    any::Any,
    collections::BTreeSet,
    panic::{catch_unwind, AssertUnwindSafe},
};

use anchor_lang::{
    error::{Error as AnchorError, ErrorOrigin},
    prelude::*,
    AccountSerialize, Accounts, Discriminator,
};
use arcium_anchor::prelude::{Cluster, ComputationDefinitionAccount, MXEAccount};
use arcium_client::{
    pda::{cluster_acc, computation_definition_acc, mxe_acc},
    ARCIUM_PROGRAM_ID,
};
use tender::{AllocateCallback, AllocateCallbackBumps, BidRecord, ErrorCode, Tender};

const STATE_QUEUED: u8 = 2;
const CLUSTER_OFFSET: u32 = 0;

#[derive(Clone)]
struct AccountFixture {
    key: Pubkey,
    owner: Pubkey,
    lamports: u64,
    data: Vec<u8>,
    is_writable: bool,
    executable: bool,
}

impl AccountFixture {
    fn new(key: Pubkey, owner: Pubkey, data: Vec<u8>, is_writable: bool, executable: bool) -> Self {
        Self {
            key,
            owner,
            lamports: 1_000_000,
            data,
            is_writable,
            executable,
        }
    }

    fn info(&mut self) -> AccountInfo<'_> {
        AccountInfo::new(
            &self.key,
            false,
            self.is_writable,
            &mut self.lamports,
            self.data.as_mut_slice(),
            &self.owner,
            self.executable,
        )
    }
}

fn account_infos<'info>(accounts: &'info mut [AccountFixture]) -> Vec<AccountInfo<'info>> {
    accounts.iter_mut().map(|account| account.info()).collect()
}

fn push_u8(data: &mut Vec<u8>, value: u8) {
    data.push(value);
}

fn push_u16(data: &mut Vec<u8>, value: u16) {
    data.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(data: &mut Vec<u8>, value: u32) {
    data.extend_from_slice(&value.to_le_bytes());
}

fn push_u64(data: &mut Vec<u8>, value: u64) {
    data.extend_from_slice(&value.to_le_bytes());
}

fn push_pubkey(data: &mut Vec<u8>, value: &Pubkey) {
    data.extend_from_slice(value.as_ref());
}

fn push_zeros<const N: usize>(data: &mut Vec<u8>) {
    data.extend_from_slice(&[0; N]);
}

fn account_data(discriminator: &[u8], body: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut data = discriminator.to_vec();
    body(&mut data);
    data
}

fn computation_definition_data() -> Vec<u8> {
    account_data(ComputationDefinitionAccount::DISCRIMINATOR, |data| {
        push_u8(data, 0); // deactivation_slot: None
        push_u64(data, 0); // cu_amount
        push_u32(data, 0); // definition.circuit_len
        push_u32(data, 0); // definition.signature.parameters: empty
        push_u32(data, 0); // definition.signature.outputs: empty
        push_u8(data, 0); // circuit_source: Local
        push_u8(data, 0); // LocalCircuitSource: MxeKeygen
        push_u8(data, 0); // bump
        push_zeros::<24>(data); // padding
    })
}

fn mxe_data(program_id: &Pubkey) -> Vec<u8> {
    account_data(MXEAccount::DISCRIMINATOR, |data| {
        push_u8(data, 0); // _padding
        push_u32(data, CLUSTER_OFFSET); // cluster
        push_u64(data, 0); // keygen_offset
        push_u64(data, 0); // key_recovery_init_offset
        push_pubkey(data, program_id); // mxe_program_id
        push_u8(data, 0); // authority: None
        push_u8(data, 0); // utility_pubkeys: Set
        push_zeros::<32>(data); // x25519_pubkey
        push_zeros::<32>(data); // ed25519_verifying_key
        push_zeros::<32>(data); // elgamal_pubkey
        push_zeros::<64>(data); // pubkey_validity_proof
        push_u64(data, 0); // lut_offset_slot
        push_u32(data, 0); // computation_definitions: empty
        push_u8(data, 0); // status: Active
        push_u8(data, 0); // bump
        push_u64(data, 0); // current_epoch_recovery_rewards
        push_u64(data, 0); // recovery_rewards_epoch
    })
}

fn cluster_data() -> Vec<u8> {
    account_data(Cluster::DISCRIMINATOR, |data| {
        push_u8(data, 0); // td_info: None
        push_u8(data, 0); // authority: None
        push_u16(data, 0); // cluster_size
        push_u64(data, 0); // activation.activation_epoch
        push_u64(data, 0); // activation.deactivation_epoch
        push_u64(data, 0); // max_capacity
        push_u64(data, 0); // cu_price
        for _ in 0..32 {
            push_u64(data, 0); // cu_price_proposals
        }
        push_u64(data, 0); // last_updated_epoch
        push_u32(data, 0); // nodes: empty
        push_u32(data, 0); // pending_nodes: empty
        push_u8(data, 0); // bls_public_key: Set
        push_zeros::<64>(data); // BN254G2BLSPublicKey
        push_u8(data, 0); // bump
        push_u64(data, 0); // current_epoch_total_rewards
        push_u64(data, 0); // rewards_epoch
        push_u64(data, 0); // leader_selector.staking_epoch
        push_u32(data, 0); // leader_selector.info: empty
    })
}

fn tender_data(tender_id: [u8; 16], computation_account: Pubkey) -> Vec<u8> {
    let tender = Tender {
        bump: 1,
        creator: Pubkey::new_unique(),
        tender_id,
        deadline: 0,
        policy_version: 1,
        computation_version: 1,
        invited: [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ],
        state: STATE_QUEUED,
        bid_count: 3,
        bids: [BidRecord::empty(); 3],
        commitment: [0xA5; 32],
        computation_offset: 1,
        computation_account,
        result_status: 255,
        lot_0_supplier: 3,
        lot_1_supplier: 3,
        lot_0_price: 0,
        lot_1_price: 0,
        total: 0,
        applied_at: 0,
    };

    let mut data = Vec::new();
    tender
        .try_serialize(&mut data)
        .expect("source Tender must serialize for the AccountInfo fixture");
    data
}

struct CallbackFixture {
    tender_a_key: Pubkey,
    tender_b_key: Pubkey,
    tender_a_data: Vec<u8>,
    tender_b_data: Vec<u8>,
    computation_a: Pubkey,
    computation_b: Pubkey,
}

impl CallbackFixture {
    fn new() -> Self {
        let computation_a = Pubkey::new_unique();
        let computation_b = Pubkey::new_unique();
        let tender_a_key = Pubkey::new_unique();
        let tender_b_key = Pubkey::new_unique();

        Self {
            tender_a_key,
            tender_b_key,
            tender_a_data: tender_data([b'A'; 16], computation_a),
            tender_b_data: tender_data([b'B'; 16], computation_b),
            computation_a,
            computation_b,
        }
    }

    fn invoke_for_b(&mut self, callback_computation: Pubkey) -> anchor_lang::Result<()> {
        let computation_definition_offset = arcium_anchor::comp_def_offset("allocate");
        let arcium_program_id = ARCIUM_PROGRAM_ID;
        let mxe_key = mxe_acc(&tender::ID);
        let cluster_key = cluster_acc(CLUSTER_OFFSET);
        let computation_definition_key =
            computation_definition_acc(&tender::ID, computation_definition_offset);
        let instructions_sysvar_key = arcium_anchor::solana_instructions_sysvar::ID;
        let tender_b_data = std::mem::take(&mut self.tender_b_data);

        let mut accounts = vec![
            AccountFixture::new(arcium_program_id, System::id(), Vec::new(), false, true),
            AccountFixture::new(
                computation_definition_key,
                arcium_program_id,
                computation_definition_data(),
                false,
                false,
            ),
            AccountFixture::new(
                mxe_key,
                arcium_program_id,
                mxe_data(&tender::ID),
                false,
                false,
            ),
            AccountFixture::new(
                callback_computation,
                arcium_program_id,
                Vec::new(),
                false,
                false,
            ),
            AccountFixture::new(cluster_key, arcium_program_id, cluster_data(), false, false),
            AccountFixture::new(
                instructions_sysvar_key,
                instructions_sysvar_key,
                Vec::new(),
                false,
                false,
            ),
            AccountFixture::new(self.tender_b_key, tender::ID, tender_b_data, true, false),
        ];

        let result = {
            let infos = account_infos(&mut accounts);
            let mut remaining = infos.as_slice();
            let mut bumps = AllocateCallbackBumps::default();
            let mut reallocs = BTreeSet::new();
            let result =
                <AllocateCallback<'_> as Accounts<'_, AllocateCallbackBumps>>::try_accounts(
                    &tender::ID,
                    &mut remaining,
                    &[],
                    &mut bumps,
                    &mut reallocs,
                );

            match result {
                Ok(_) => {
                    assert!(
                        remaining.is_empty(),
                        "matching account validation did not consume all accounts"
                    );
                    Ok(())
                }
                Err(error) => Err(error),
            }
        };

        self.tender_b_data = accounts
            .pop()
            .expect("tender B fixture must be the final callback account")
            .data;
        result
    }
}

fn expect_wrong_computation<T>(result: anchor_lang::Result<T>) {
    match result {
        Ok(_) => panic!("WRONG_CONTEXT_ASSERTION_UNEXPECTED_SUCCESS"),
        Err(AnchorError::AnchorError(error)) => {
            assert_eq!(
                error.error_code_number,
                u32::from(ErrorCode::WrongComputationAccount),
                "WRONG_CONTEXT_ASSERTION_UNRELATED_ERROR: {}",
                error.error_code_number
            );
            match error.error_origin.as_ref() {
                Some(ErrorOrigin::AccountName(name)) if name == "tender" => {}
                _ => panic!("WRONG_CONTEXT_ASSERTION_UNRELATED_ERROR_ORIGIN"),
            }
        }
        Err(_) => panic!("WRONG_CONTEXT_ASSERTION_UNRELATED_ERROR"),
    }
}

fn panic_message(payload: &(dyn Any + Send)) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_owned()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "<non-string panic>".to_owned()
    }
}

fn assert_helper_panics_with(expected_marker: &str, action: impl FnOnce()) {
    let payload = catch_unwind(AssertUnwindSafe(action)).expect_err(
        "WRONG_CONTEXT_HELPER_CONTROL: assertion helper unexpectedly accepted the input",
    );
    let message = panic_message(payload.as_ref());
    assert!(
        message.contains(expected_marker),
        "WRONG_CONTEXT_HELPER_CONTROL: expected {expected_marker}, got {message}"
    );
}

#[test]
fn authored_allocate_callback_validates_computation_context() {
    let mut fixture = CallbackFixture::new();
    let computation_a = fixture.computation_a;
    let computation_b = fixture.computation_b;
    assert_ne!(fixture.tender_a_key, fixture.tender_b_key);
    assert_ne!(computation_a, computation_b);
    let tender_a_before = fixture.tender_a_data.clone();
    let tender_b_before = fixture.tender_b_data.clone();

    let mismatch = fixture.invoke_for_b(computation_a);
    expect_wrong_computation(mismatch);
    assert_eq!(fixture.tender_a_data, tender_a_before);
    assert_eq!(fixture.tender_b_data, tender_b_before);

    let matching = fixture.invoke_for_b(computation_b);
    assert!(
        matching.is_ok(),
        "matching B/B account validation failed: {matching:?}"
    );
    assert_eq!(fixture.tender_a_data, tender_a_before);
    assert_eq!(fixture.tender_b_data, tender_b_before);

    let success_control = || expect_wrong_computation(fixture.invoke_for_b(computation_b));
    assert_helper_panics_with(
        "WRONG_CONTEXT_ASSERTION_UNEXPECTED_SUCCESS",
        success_control,
    );

    let unrelated_error: anchor_lang::Result<()> = Err(ErrorCode::ResultAlreadyApplied.into());
    assert_helper_panics_with("WRONG_CONTEXT_ASSERTION_UNRELATED_ERROR", || {
        expect_wrong_computation(unrelated_error)
    });

    assert_eq!(fixture.tender_a_data, tender_a_before);
    assert_eq!(fixture.tender_b_data, tender_b_before);
}
