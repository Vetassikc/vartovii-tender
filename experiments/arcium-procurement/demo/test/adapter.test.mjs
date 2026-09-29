import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { RescueCipher, x25519 } from "@arcium-hq/client";
import { deriveRescueSharedSecret, requireTenderDto } from "../src/protocol.mjs";
import * as adapter from "../server/adapter.mjs";
import {
  projectTenderFromAccount,
  provisionSupplierFeePayerWithTransport,
  validateSupplierProvisioningRequest,
  validateSupplierTransaction,
} from "../server/adapter.mjs";

const programId = new PublicKey("5ZmtkAKZ3Da8PeoeCcC8S7Wcec8VthjomvzvihUKzK1W");
const submitDiscriminator = Buffer.from([19, 164, 237, 254, 64, 139, 237, 93]);

test("supplier relay accepts only the two-instruction signed protocol shape", () => {
  const supplier = Keypair.generate();
  const tenderId = Buffer.alloc(16, 7);
  const [tender] = PublicKey.findProgramAddressSync([Buffer.from("tender"), tenderId], programId);
  const message = Buffer.from("signed-protocol-message");
  const signature = Buffer.alloc(64, 9);
  const ed25519 = Ed25519Program.createInstructionWithPublicKey({
    publicKey: supplier.publicKey.toBytes(),
    message,
    signature,
  });
  const encryptedFields = Buffer.alloc(96, 3);
  const encryptionPublicKey = Buffer.alloc(32, 4);
  const nonce = Buffer.alloc(16, 5);
  const supplierSignature = Buffer.alloc(64, 6);
  const submitData = Buffer.concat([
    submitDiscriminator,
    tenderId,
    Buffer.from([1]),
    encryptedFields,
    encryptionPublicKey,
    nonce,
    supplierSignature,
  ]);
  const submit = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: tender, isSigner: false, isWritable: true },
      { pubkey: supplier.publicKey, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: submitData,
  });
  const transaction = new Transaction({
    feePayer: supplier.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(ed25519, submit);
  transaction.sign(supplier);
  const raw = transaction.serialize();
  const parsed = validateSupplierTransaction(raw, 1);

  assert.equal(parsed.slot, 1);
  assert.equal(parsed.tender.toBase58(), tender.toBase58());
  assert.equal(parsed.supplier.toBase58(), supplier.publicKey.toBase58());
  assert.equal(parsed.supplierSignaturePresent, true);
  assert.equal(raw.includes(Buffer.from("canonical-secret-price-40")), false);
});

test("supplier relay rejects a slot mismatch and extra instruction", () => {
  const supplier = Keypair.generate();
  const tenderId = Buffer.alloc(16, 8);
  const [tender] = PublicKey.findProgramAddressSync([Buffer.from("tender"), tenderId], programId);
  const ed25519 = Ed25519Program.createInstructionWithPublicKey({
    publicKey: supplier.publicKey.toBytes(),
    message: Buffer.from("m"),
    signature: Buffer.alloc(64, 1),
  });
  const submit = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: tender, isSigner: false, isWritable: true },
      { pubkey: supplier.publicKey, isSigner: true, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([submitDiscriminator, tenderId, Buffer.from([0]), Buffer.alloc(96 + 32 + 16 + 64)]),
  });
  const transaction = new Transaction({
    feePayer: supplier.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(ed25519, submit);
  transaction.sign(supplier);
  assert.throws(() => validateSupplierTransaction(transaction.serialize(), 1), /slot/);

  const extra = new Transaction({
    feePayer: supplier.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(ed25519, submit, SystemProgram.transfer({ fromPubkey: supplier.publicKey, toPubkey: tender, lamports: 1 }));
  extra.sign(supplier);
  assert.throws(() => validateSupplierTransaction(extra.serialize(), 0), /exactly two instructions/);
});

test("actual projected tender DTO feeds B2-compatible browser crypto", () => {
  const tenderId = Buffer.alloc(16, 12);
  const [tender] = PublicKey.findProgramAddressSync([Buffer.from("tender"), tenderId], programId);
  const account = syntheticTenderAccount(tenderId, 0);
  const dto = projectTenderFromAccount(tender, account);
  assert.equal(dto.deadline, 4102444800);
  assert.equal(dto.resultStatus, 0);
  assert.equal(requireTenderDto(dto), dto);

  const browserPrivate = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const peerPrivate = Uint8Array.from({ length: 32 }, (_, index) => 200 + index);
  const browserPublic = x25519.getPublicKey(browserPrivate);
  const peerPublic = x25519.getPublicKey(peerPrivate);
  const browserShared = deriveRescueSharedSecret(browserPrivate, peerPublic);
  const peerShared = x25519.getSharedSecret(peerPrivate, browserPublic);
  assert.deepEqual(Array.from(browserShared), Array.from(peerShared));

  const nonce = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const ciphertexts = new RescueCipher(browserShared).encrypt([40n, 40n, 1n], nonce).map((value) => Uint8Array.from(value));
  const plaintext = new RescueCipher(peerShared).decrypt(ciphertexts.map((value) => Array.from(value)), nonce);
  assert.deepEqual(plaintext, [40n, 40n, 1n]);
});

test("projected finalized nonzero result has no award", () => {
  const tenderId = Buffer.alloc(16, 13);
  const [tender] = PublicKey.findProgramAddressSync([Buffer.from("tender"), tenderId], programId);
  const dto = projectTenderFromAccount(tender, syntheticTenderAccount(tenderId, 1));
  assert.equal(dto.resultStatus, 1);
  assert.equal(dto.award, null);
  assert.equal(dto.verification, "finalized-with-nonzero-result-status-no-award");
  assert.match(dto.stateLabel, /no valid allocation/i);
});

test("supplier provisioning is limited to the invited public key and records transport", async () => {
  const supplier = Keypair.generate();
  const invited = [supplier.publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
  const account = { invited };
  const input = { tender: programId.toBase58(), slot: 0, supplier: supplier.publicKey.toBase58() };
  assert.deepEqual(validateSupplierProvisioningRequest(account, input).supplier.toBase58(), supplier.publicKey.toBase58());

  const calls = [];
  const transport = {
    async requestAirdrop(publicKey, lamports) {
      calls.push({ method: "requestAirdrop", publicKey: publicKey.toBase58(), lamports });
      return "synthetic-airdrop-signature";
    },
    async confirmTransaction(signature, commitment) {
      calls.push({ method: "confirmTransaction", signature, commitment });
    },
  };
  const result = await provisionSupplierFeePayerWithTransport(account, input, transport);
  assert.equal(result.slot, 0);
  assert.equal(result.supplier, supplier.publicKey.toBase58());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].lamports, 500_000_000);
  assert.throws(
    () => validateSupplierProvisioningRequest(account, { ...input, supplier: Keypair.generate().publicKey.toBase58() }),
    /not invited/
  );
});

test("MXE setup signer is distinct from the buyer and matches management authority", () => {
  const requireMxeSetupAuthority = adapter.requireMxeSetupAuthority;
  assert.equal(typeof requireMxeSetupAuthority, "function");

  const buyer = Keypair.generate();
  const setupSigner = Keypair.generate();

  assert.notEqual(setupSigner.publicKey.toBase58(), buyer.publicKey.toBase58());
  assert.equal(
    requireMxeSetupAuthority(setupSigner, buyer.publicKey, setupSigner.publicKey),
    setupSigner
  );
});

test("MXE setup authority gate rejects a mismatching signer", () => {
  const requireMxeSetupAuthority = adapter.requireMxeSetupAuthority;
  assert.equal(typeof requireMxeSetupAuthority, "function");

  const buyer = Keypair.generate();
  const setupSigner = Keypair.generate();
  const authority = Keypair.generate().publicKey;

  assert.throws(
    () => requireMxeSetupAuthority(setupSigner, buyer.publicKey, authority),
    /does not match/i
  );
});

test("MXE setup authority gate rejects an absent management authority", () => {
  const requireMxeSetupAuthority = adapter.requireMxeSetupAuthority;
  assert.equal(typeof requireMxeSetupAuthority, "function");

  assert.throws(
    () => requireMxeSetupAuthority(Keypair.generate(), Keypair.generate().publicKey, null),
    /authority is unavailable/i
  );
});

test("MXE setup authority gate rejects reusing the buyer signer", () => {
  const requireMxeSetupAuthority = adapter.requireMxeSetupAuthority;
  assert.equal(typeof requireMxeSetupAuthority, "function");

  const buyer = Keypair.generate();

  assert.throws(
    () => requireMxeSetupAuthority(buyer, buyer.publicKey, buyer.publicKey),
    /separate from the buyer/i
  );
});

test("setup key path is fixed inside the active correction run", () => {
  const resolveSetupKeypairPath = adapter.resolveSetupKeypairPath;
  assert.equal(typeof resolveSetupKeypairPath, "function");

  const runRoot = path.resolve("/tmp/b3-authority-correction/run-20260922T215434Z");
  const projectRoot = path.join(runRoot, "project");
  const setupKeyPath = path.join(runRoot, "keys", "setup-authority.json");

  assert.equal(resolveSetupKeypairPath(runRoot, setupKeyPath, projectRoot), setupKeyPath);
  assert.throws(
    () => resolveSetupKeypairPath(runRoot, path.join(runRoot, "old-b2-payer.json"), projectRoot),
    /active run/i
  );
  assert.throws(
    () => resolveSetupKeypairPath(runRoot, setupKeyPath, path.join(runRoot, "elsewhere")),
    /isolated project/i
  );
});

function syntheticTenderAccount(tenderId, resultStatus) {
  return {
    tenderId,
    deadline: 4102444800,
    state: 3,
    resultStatus,
    bidCount: 3,
    commitment: Buffer.alloc(32, 1),
    computationOffset: { toString: () => "77" },
    computationAccount: programId,
    lot0Supplier: 2,
    lot1Supplier: 0,
    lot0Price: 45,
    lot1Price: 40,
    total: 85,
    appliedAt: 4102444800,
  };
}
