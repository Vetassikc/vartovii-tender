import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import anchorPackage from "@anchor-lang/core";
import * as anchor from "@anchor-lang/core";
import {
  Ed25519Program,
  Keypair,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  sendAndConfirmRawTransaction,
} from "@solana/web3.js";
import {
  awaitComputationFinalization,
  getArciumAccountBaseSeed,
  getArciumEnv,
  getArciumProgram,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getLookupTableAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  uploadCircuit,
} from "@arcium-hq/client";

const { BN } = anchorPackage;
process.env.ARCIUM_CLUSTER_OFFSET ??= "0";

const DEMO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(DEMO_ROOT, "../../..");
const B2_RUNTIME = path.join(REPO_ROOT, ".runtime/arcium-spike/b2/tender");
const B3_RUNTIME = path.join(REPO_ROOT, ".runtime/arcium-spike/b3");
const IDL_PATH = path.join(B2_RUNTIME, "target/idl/tender.json");
const CIRCUIT_PATH = path.join(B2_RUNTIME, "build/allocate.arcis");
const RPC_URL = "http://127.0.0.1:8899";
const NETWORK = "localnet-loopback";
const PROGRAM_ID = new PublicKey("5ZmtkAKZ3Da8PeoeCcC8S7Wcec8VthjomvzvihUKzK1W");
const SUBMIT_BID_DISCRIMINATOR = Uint8Array.from([19, 164, 237, 254, 64, 139, 237, 93]);
const ED25519_PROGRAM_ID = Ed25519Program.programId;
const SUPPLIER_AIRDROP_LAMPORTS = 500_000_000;
const STATE_NAMES = ["open", "frozen", "queued", "finalized"];
const TENDER_CREATE_STAGES = new Set([
  "pre_sign",
  "signing_unknown",
  "signed_unsubmitted",
  "submission_unknown",
  "submitted_unconfirmed",
  "confirmed_failure",
  "post_confirmation",
]);
const observations = new Map();

let runtimeStatus = "pending";
let runtimeDetail = "The approved local validator and Arcium nodes are not connected yet.";
let runtimePromise = null;
let lastRuntimeAttempt = 0;
let mxePublicKey = null;

const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const connection = new anchor.web3.Connection(RPC_URL, "confirmed");
const buyer = Keypair.generate();
const wallet = new anchor.Wallet(buyer);
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
const program = new anchor.Program(idl, provider);

export function getConfig() {
  return ensureRuntime()
    .then(() => configPayload())
    .catch(() => configPayload());
}

export class TenderCreationFailure extends Error {
  constructor(stage, statusCode = 500) {
    if (!TENDER_CREATE_STAGES.has(stage)) throw new TypeError("Invalid tender creation stage.");
    super("Tender creation failed.");
    this.name = "TenderCreationFailure";
    this.stage = stage;
    this.statusCode = statusCode === 503 ? 503 : 500;
  }
}

export function observeTenderCreateWallet(wallet, onStage) {
  if (typeof wallet?.signTransaction !== "function" || typeof onStage !== "function") {
    throw new TypeError("Tender creation signer observer is unavailable.");
  }
  const observedWallet = {
    publicKey: wallet.publicKey,
    async signTransaction(transaction) {
      onStage("signing_unknown");
      const signed = await wallet.signTransaction(transaction);
      onStage("signed_unsubmitted");
      return signed;
    },
  };
  if (typeof wallet.signAllTransactions === "function") {
    observedWallet.signAllTransactions = async (transactions) => {
      if (transactions.length > 0) onStage("signing_unknown");
      const signed = await wallet.signAllTransactions(transactions);
      if (signed.length > 0) onStage("signed_unsubmitted");
      return signed;
    };
  }
  return observedWallet;
}

export function observeTenderCreateConnection(connection, onStage) {
  if (
    typeof connection?.sendRawTransaction !== "function" ||
    typeof connection?.confirmTransaction !== "function" ||
    typeof onStage !== "function"
  ) {
    throw new TypeError("Tender creation connection observer is unavailable.");
  }
  const sendRawTransaction = connection.sendRawTransaction.bind(connection);
  const confirmTransaction = connection.confirmTransaction.bind(connection);
  connection.sendRawTransaction = async (...args) => {
    onStage("submission_unknown");
    const signature = await sendRawTransaction(...args);
    if (typeof signature === "string" && signature.length > 0) {
      onStage("submitted_unconfirmed");
    }
    return signature;
  };
  connection.confirmTransaction = async (...args) => {
    const confirmation = await confirmTransaction(...args);
    if (confirmation?.value?.err === null) onStage("post_confirmation");
    else if (confirmation?.value?.err !== undefined) onStage("confirmed_failure");
    return confirmation;
  };
  return connection;
}

export function submitTenderCreate(createProgram, { tenderId, invited, deadline, creator }) {
  return createProgram.methods
    .createTender(
      Array.from(tenderId),
      invited,
      new BN(deadline)
    )
    .accounts({ creator })
    .rpc({ commitment: "confirmed" });
}

export async function createTender(input = {}) {
  let stage = "pre_sign";
  try {
    await requireRuntime();
    const invited = parseInvited(input.invited);
    const deadline = parseDeadline(input.deadline);
    const tenderId = parseTenderId(input.tenderId) ?? randomBytes(16);
    const [tender] = PublicKey.findProgramAddressSync(
      [Buffer.from("tender"), tenderId],
      PROGRAM_ID
    );
    const createConnection = new anchor.web3.Connection(RPC_URL, "confirmed");
    const onStage = (nextStage) => { stage = nextStage; };
    observeTenderCreateConnection(createConnection, onStage);
    const createWallet = observeTenderCreateWallet(wallet, onStage);
    const createProvider = new anchor.AnchorProvider(createConnection, createWallet, {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    const createProgram = new anchor.Program(idl, createProvider);
    const signature = await submitTenderCreate(createProgram, {
      tenderId,
      invited,
      deadline,
      creator: buyer.publicKey,
    });
    stage = "post_confirmation";
    observations.set(tender.toBase58(), { createdAt: new Date().toISOString(), createSignature: signature });
    return await projectTender(tender, { signature });
  } catch (error) {
    const statusCode = stage === "pre_sign" && error?.statusCode === 503 ? 503 : 500;
    throw new TenderCreationFailure(stage, statusCode);
  }
}

export async function relaySupplierBid(input = {}) {
  await requireRuntime();
  const raw = decodeRawTransaction(input.rawTransaction);
  const parsed = parseSupplierTransaction(raw, input.slot);
  const tender = await fetchTenderAccount(parsed.tender);
  const slot = parsed.slot;
  if (tender.state !== 0) throw new Error("Tender is no longer open.");
  if (!tender.invited[slot].equals(parsed.supplier)) throw new Error("Supplier is not invited for this slot.");
  if (tender.bids[slot]?.present) throw new Error("This supplier slot already has a bid.");
  if (!parsed.supplierSignaturePresent) throw new Error("Supplier transaction is not signed.");
  const signature = await sendAndConfirmRawTransaction(connection, raw, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false,
  });
  return projectTender(parsed.tender, { signature });
}

export async function provisionSupplierFeePayer(input = {}) {
  await requireRuntime();
  const tender = toPublicKey(input.tender, "tender");
  const account = await fetchTenderAccount(tender);
  return provisionSupplierFeePayerWithTransport(account, input, connection);
}

export async function provisionSupplierFeePayerWithTransport(account, input = {}, transport) {
  const { slot, supplier } = validateSupplierProvisioningRequest(account, input);
  if (!transport || typeof transport.requestAirdrop !== "function" || typeof transport.confirmTransaction !== "function") {
    throw new Error("Supplier provisioning transport is not supported.");
  }
  const signature = await transport.requestAirdrop(supplier, SUPPLIER_AIRDROP_LAMPORTS);
  await transport.confirmTransaction(signature, "confirmed");
  return { tender: input.tender, slot, supplier: supplier.toBase58(), lamports: SUPPLIER_AIRDROP_LAMPORTS, signature };
}

export function validateSupplierProvisioningRequest(account, input = {}) {
  const slot = parseSlot(input.slot);
  const supplier = toPublicKey(input.supplier, "supplier public key");
  if (!account?.invited?.[slot]?.equals?.(supplier)) throw new Error("Supplier is not invited for this slot.");
  return { slot, supplier };
}

export async function freezeTender(tenderAddress) {
  await requireRuntime();
  const tender = toPublicKey(tenderAddress, "tender");
  const account = await fetchTenderAccount(tender);
  const signature = await program.methods
    .freezeTender(Array.from(Buffer.from(account.tenderId)))
    .accounts({ tender, creator: buyer.publicKey })
    .signers([buyer])
    .rpc({ commitment: "confirmed" });
  note(tender, { freezeSignature: signature, frozenAt: new Date().toISOString() });
  return projectTender(tender, { signature });
}

export async function queueTender(tenderAddress) {
  await requireRuntime();
  const tender = toPublicKey(tenderAddress, "tender");
  const account = await fetchTenderAccount(tender);
  if (Number(account.state) !== 1) throw new Error("Only a frozen tender can be queued.");
  const env = getArciumEnv();
  const computationOffset = createQueueTenderOffset();
  const queueSignature = await program.methods
    .queueTender(Array.from(Buffer.from(account.tenderId)), computationOffset)
    .accountsPartial({
      tender,
      payer: buyer.publicKey,
      computationAccount: getComputationAccAddress(env.arciumClusterOffset, computationOffset),
      clusterAccount: getClusterAccAddress(env.arciumClusterOffset),
      mxeAccount: getMXEAccAddress(PROGRAM_ID),
      mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(
        PROGRAM_ID,
        Buffer.from(getCompDefAccOffset("allocate")).readUInt32LE()
      ),
    })
    .signers([buyer])
    .rpc({ skipPreflight: true, commitment: "confirmed" });
  note(tender, {
    queueSignature,
    computationOffset: computationOffset.toString(),
    queuedAt: new Date().toISOString(),
  });
  try {
    const finalizationSignature = await awaitComputationFinalization(
      provider,
      computationOffset,
      PROGRAM_ID,
      "confirmed",
      120_000
    );
    note(tender, { finalizationSignature, finalizedAt: new Date().toISOString() });
    const final = await waitForFinalizedTender(tender);
    return projectTender(tender, { signature: queueSignature, finalizationSignature, final });
  } catch (error) {
    note(tender, { queueError: safeMessage(error), pendingAt: new Date().toISOString() });
    const pending = await projectTender(tender, { queueSignature });
    return {
      ...pending,
      signature: queueSignature,
      operationStatus: "pending",
      error: "Computation is still pending; no award is available.",
    };
  }
}

export function createQueueTenderOffset(bytes = randomBytes(8)) {
  return new BN(bytes, "le");
}

export async function readTender(tenderAddress) {
  await requireRuntime();
  return projectTender(toPublicKey(tenderAddress, "tender"));
}

export async function readReceipt(tenderAddress) {
  await requireRuntime();
  return projectTender(toPublicKey(tenderAddress, "tender"));
}

export async function shutdownAdapter() {
  connection._rpcWebSocket?.close?.();
}

export function validateSupplierTransaction(raw, requestedSlot) {
  return parseSupplierTransaction(raw, requestedSlot);
}

async function ensureRuntime() {
  if (runtimeStatus === "ready") return;
  if (runtimePromise) return runtimePromise;
  if (Date.now() - lastRuntimeAttempt < 5000) throw new Error(runtimeDetail);
  lastRuntimeAttempt = Date.now();
  runtimePromise = initializeRuntime()
    .then(() => {
      runtimeStatus = "ready";
      runtimeDetail = "Local validator, program, MXE key and allocation circuit are ready.";
    })
    .catch((error) => {
      runtimeStatus = "unavailable";
      runtimeDetail = safeMessage(error);
      throw error;
    })
    .finally(() => {
      runtimePromise = null;
    });
  return runtimePromise;
}

async function initializeRuntime() {
  await connection.getVersion();
  const setupSigner = loadMxeSetupSigner();
  const setupProvider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(setupSigner),
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  const setupProgram = new anchor.Program(idl, setupProvider);
  mxePublicKey = await getMXEPublicKeyWithRetry(setupProvider);
  const setupEvidence = await initAllocateCompDef(setupProgram, setupSigner, setupProvider);
  const balance = await connection.getBalance(buyer.publicKey, "confirmed");
  if (balance < 1_000_000_000) {
    const signature = await connection.requestAirdrop(buyer.publicKey, 2_000_000_000);
    await connection.confirmTransaction(signature, "confirmed");
  }
  fs.mkdirSync(B3_RUNTIME, { recursive: true });
  fs.writeFileSync(
    path.join(B3_RUNTIME, "runtime-marker.json"),
    JSON.stringify({
      network: NETWORK,
      programId: PROGRAM_ID.toBase58(),
      setupAuthorityVerified: true,
      setupEvidence,
      readyAt: new Date().toISOString(),
    }, null, 2) + "\n",
    "utf8"
  );
}

function loadMxeSetupSigner() {
  const runRoot = process.env.B3_AUTHORITY_CORRECTION_RUN_ROOT;
  const setupKeyPath = process.env.B3_SETUP_KEYPAIR_PATH;
  const resolvedSetupKeyPath = resolveSetupKeypairPath(runRoot, setupKeyPath, REPO_ROOT);
  let runRootRealPath;
  let projectRealPath;
  let keyRealPath;
  let keyStats;
  try {
    runRootRealPath = fs.realpathSync(runRoot);
    projectRealPath = fs.realpathSync(REPO_ROOT);
    keyRealPath = fs.realpathSync(resolvedSetupKeyPath);
    keyStats = fs.lstatSync(resolvedSetupKeyPath);
  } catch {
    throw new Error("Run-owned MXE setup signer is unavailable.");
  }

  const expectedProjectPath = path.join(runRootRealPath, "project");
  const expectedKeyPath = path.join(runRootRealPath, "keys", "setup-authority.json");
  if (
    runRootRealPath !== path.resolve(runRoot) ||
    projectRealPath !== expectedProjectPath ||
    keyRealPath !== expectedKeyPath ||
    keyStats.isSymbolicLink() ||
    !keyStats.isFile() ||
    (keyStats.mode & 0o077) !== 0
  ) {
    throw new Error("MXE setup signer must be a private file inside the active correction run.");
  }

  try {
    const secretKey = JSON.parse(fs.readFileSync(resolvedSetupKeyPath, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch {
    throw new Error("Run-owned MXE setup signer is invalid.");
  }
}

export function resolveSetupKeypairPath(runRoot, setupKeyPath, projectRoot) {
  if (
    typeof runRoot !== "string" || !path.isAbsolute(runRoot) ||
    typeof setupKeyPath !== "string" || !path.isAbsolute(setupKeyPath) ||
    typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)
  ) {
    throw new Error("Explicit absolute run, setup-key, and isolated-project paths are required.");
  }
  const resolvedRunRoot = path.resolve(runRoot);
  if (path.resolve(projectRoot) !== path.join(resolvedRunRoot, "project")) {
    throw new Error("MXE setup signer must be used from the isolated project in the active run.");
  }
  const expectedKeyPath = path.join(resolvedRunRoot, "keys", "setup-authority.json");
  if (path.resolve(setupKeyPath) !== expectedKeyPath) {
    throw new Error("MXE setup key path must be the fixed key inside the active run.");
  }
  return expectedKeyPath;
}

export function requireMxeSetupAuthority(setupSigner, buyerPublicKey, mxeAuthority) {
  if (!mxeAuthority) throw new Error("MXE management authority is unavailable.");
  if (!setupSigner?.publicKey || !buyerPublicKey) throw new Error("MXE setup signer is unavailable.");
  if (setupSigner.publicKey.equals(buyerPublicKey)) {
    throw new Error("MXE setup signer must be separate from the buyer.");
  }
  let authority;
  try {
    authority = new PublicKey(mxeAuthority);
  } catch {
    throw new Error("MXE management authority is unavailable.");
  }
  if (!setupSigner.publicKey.equals(authority)) {
    throw new Error("MXE setup signer does not match the MXE management authority.");
  }
  return setupSigner;
}

async function initAllocateCompDef(setupProgram, setupSigner, setupProvider) {
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("allocate");
  const compDefPda = PublicKey.findProgramAddressSync(
    [baseSeed, PROGRAM_ID.toBuffer(), offset],
    getArciumProgramId()
  )[0];
  const arciumProgram = getArciumProgram(setupProvider);
  const mxeAccount = getMXEAccAddress(PROGRAM_ID);
  const mxe = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  requireMxeSetupAuthority(setupSigner, buyer.publicKey, mxe.authority);
  const lutAddress = getLookupTableAddress(PROGRAM_ID, mxe.lutOffsetSlot);
  const existing = await arciumProgram.account.computationDefinitionAccount.fetchNullable(compDefPda);
  let initializationSignature = null;
  if (!existing) {
    initializationSignature = await setupProgram.methods
      .initAllocateCompDef()
      .accounts({
        compDefAccount: compDefPda,
        payer: setupSigner.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([setupSigner])
      .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });
  }
  const rawCircuit = fs.readFileSync(CIRCUIT_PATH);
  const circuitUploadSignatures = await uploadCircuit(
    setupProvider,
    "allocate",
    PROGRAM_ID,
    rawCircuit,
    false
  );
  return {
    computationDefinition: compDefPda.toBase58(),
    initializationSignature,
    circuitUploadSignatures,
  };
}

async function getMXEPublicKeyWithRetry(readProvider, maxRetries = 20) {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const value = await getMXEPublicKey(readProvider, PROGRAM_ID);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The local MXE public key is not ready.");
}

async function requireRuntime() {
  try {
    await ensureRuntime();
  } catch (error) {
    const wrapped = new Error(`Local Arcium runtime unavailable: ${safeMessage(error)}`);
    wrapped.statusCode = 503;
    throw wrapped;
  }
}

function configPayload() {
  return {
    ready: runtimeStatus === "ready",
    status: runtimeStatus,
    detail: runtimeDetail,
    network: NETWORK,
    rpcUrl: RPC_URL,
    programId: PROGRAM_ID.toBase58(),
    mxePublicKey: mxePublicKey ? Buffer.from(mxePublicKey).toString("base64") : null,
    supplierSlots: 3,
    lotCount: 2,
  };
}

async function projectTender(tender, extra = {}) {
  const account = await fetchTenderAccount(tender);
  return projectTenderFromAccount(tender, account, extra);
}

export function projectTenderFromAccount(tender, account, extra = {}) {
  const tenderKey = tender instanceof PublicKey ? tender : toPublicKey(tender, "tender");
  const stateNumber = Number(account.state);
  const state = STATE_NAMES[stateNumber] ?? "unavailable";
  const resultStatus = Number.isSafeInteger(account.resultStatus) ? account.resultStatus : null;
  const verified = state === "finalized" && resultStatus === 0;
  const deadline = Number(account.deadline);
  const obs = observations.get(tenderKey.toBase58()) ?? {};
  const computation = {
    offset: account.computationOffset.toString(),
    account: account.computationAccount.toBase58(),
    queueSignature: obs.queueSignature ?? null,
    finalizationSignature: obs.finalizationSignature ?? null,
  };
  const result = {
    status: resultStatus,
    winners: [Number(account.lot0Supplier), Number(account.lot1Supplier)],
    winningPrices: [Number(account.lot0Price), Number(account.lot1Price)],
    total: Number(account.total),
  };
  const timestamps = {
    deadline: new Date(deadline * 1000).toISOString(),
    appliedAt: Number(account.appliedAt) ? new Date(Number(account.appliedAt) * 1000).toISOString() : null,
    createdAt: obs.createdAt ?? null,
    frozenAt: obs.frozenAt ?? null,
    queuedAt: obs.queuedAt ?? null,
    finalizedAt: obs.finalizedAt ?? null,
    readAt: new Date().toISOString(),
  };
  const response = {
    tender: tenderKey.toBase58(),
    tenderId: Buffer.from(account.tenderId).toString("hex"),
    deadline,
    resultStatus,
    state,
    stateNumber,
    stateLabel: stateLabel(state, resultStatus),
    bidCount: Number(account.bidCount),
    commitment: Buffer.from(account.commitment).toString("hex"),
    computation,
    programId: PROGRAM_ID.toBase58(),
    network: NETWORK,
    verification: verified ? "verified-finalized-program-state" : verificationLabel(state, resultStatus),
    timestamps,
    award: verified
      ? { lot0Supplier: result.winners[0], lot1Supplier: result.winners[1], lot0Price: result.winningPrices[0], lot1Price: result.winningPrices[1], total: result.total }
      : null,
    receipt: {
      tender: tenderKey.toBase58(),
      tenderId: Buffer.from(account.tenderId).toString("hex"),
      deadline,
      commitment: Buffer.from(account.commitment).toString("hex"),
      computation,
      programIdentity: { programId: PROGRAM_ID.toBase58(), source: "existing B2 tender program" },
      sourceNetwork: NETWORK,
      verification: verified ? "verified-finalized-program-state" : verificationLabel(state, resultStatus),
      timestamps,
      provenance: {
        award: verified ? "read from finalized Tender account after local Arcium computation finalization" : "no award; program account is not finalized with a valid result",
        adapter: "loopback read-only projection; buyer payer and runtime are local synthetic helpers",
        trustBoundary: "browser-origin isolation on one local machine is not independent trust",
      },
    },
    ...extra,
  };
  if (extra.final) delete response.final;
  return response;
}

async function waitForFinalizedTender(tender, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const account = await fetchTenderAccount(tender);
    if (Number(account.state) === 3) return account;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Computation finalized but the tender account did not reach finalized state.");
}

async function fetchTenderAccount(tender) {
  try {
    return await program.account.tender.fetch(tender, "confirmed");
  } catch (error) {
    const wrapped = new Error(`Tender account unavailable: ${safeMessage(error)}`);
    wrapped.statusCode = 404;
    throw wrapped;
  }
}

function parseSupplierTransaction(raw, requestedSlot) {
  let transaction;
  try {
    transaction = Transaction.from(raw);
  } catch {
    throw new Error("Supplier payload is not a serialized Solana transaction.");
  }
  if (transaction.instructions.length !== 2) throw new Error("Supplier transaction must contain exactly two instructions.");
  const [ed25519, submit] = transaction.instructions;
  if (!ed25519.programId.equals(ED25519_PROGRAM_ID)) throw new Error("First supplier instruction must be Ed25519 verification.");
  if (!submit.programId.equals(PROGRAM_ID)) throw new Error("Second supplier instruction must target the tender program.");
  if (submit.keys.length !== 3) throw new Error("Supplier submit instruction has an unexpected account shape.");
  if (!submit.keys[2].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)) throw new Error("Supplier submit instruction lacks the instruction sysvar.");
  if (submit.data.length !== 233 || !bytesEqual(submit.data.subarray(0, 8), SUBMIT_BID_DISCRIMINATOR)) throw new Error("Supplier submit instruction has unexpected serialization.");
  const tenderId = submit.data.subarray(8, 24);
  const slot = submit.data[24];
  if (requestedSlot !== undefined && Number(requestedSlot) !== slot) throw new Error("Supplier slot does not match the signed instruction.");
  const tender = PublicKey.findProgramAddressSync([Buffer.from("tender"), tenderId], PROGRAM_ID)[0];
  if (!submit.keys[0].pubkey.equals(tender)) throw new Error("Supplier transaction targets a different tender PDA.");
  const supplier = submit.keys[1].pubkey;
  if (!transaction.feePayer?.equals(supplier)) throw new Error("Supplier must pay and sign its own bid transaction.");
  const supplierSignaturePresent = transaction.signatures.some((entry) => entry.publicKey.equals(supplier) && entry.signature);
  return { tender, slot, supplier, supplierSignaturePresent };
}

function decodeRawTransaction(value) {
  if (typeof value !== "string" || value.length > 16_000) throw new Error("Supplier payload must be a bounded base64 transaction.");
  let raw;
  try { raw = Buffer.from(value, "base64"); } catch { throw new Error("Supplier payload is not base64."); }
  if (!raw.length || raw.toString("base64") !== value.replace(/\s/g, "")) throw new Error("Supplier payload is not canonical base64.");
  return raw;
}

function parseInvited(value) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error("Exactly three invited supplier public keys are required.");
  const invited = value.map((entry) => toPublicKey(entry, "supplier public key"));
  if (new Set(invited.map((entry) => entry.toBase58())).size !== 3) throw new Error("Invited supplier public keys must be distinct.");
  return invited;
}

function parseDeadline(value) {
  const deadline = value === undefined ? Math.floor(Date.now() / 1000) + 900 : Number(value);
  if (!Number.isSafeInteger(deadline) || deadline <= Math.floor(Date.now() / 1000) + 20 || deadline > Math.floor(Date.now() / 1000) + 3600) throw new Error("Deadline must be 20 seconds to one hour in the future.");
  return deadline;
}

function parseTenderId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-f]{32}$/i.test(value)) throw new Error("Tender id must be exactly 16 bytes encoded as hex.");
  return Buffer.from(value, "hex");
}

function parseSlot(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) throw new Error("Supplier slot must be 0, 1, or 2.");
  return slot;
}

function toPublicKey(value, label) {
  try { return new PublicKey(value); } catch { throw new Error(`Invalid ${label}.`); }
}

function note(tender, values) {
  const key = tender.toBase58();
  observations.set(key, { ...(observations.get(key) ?? {}), ...values });
}

function stateLabel(state, resultStatus) {
  if (state === "finalized" && resultStatus !== 0) return "Finalized — no valid allocation";
  return { open: "Open — waiting for encrypted bids", frozen: "Frozen — commitment retained", queued: "Queued — MPC computation pending", finalized: "Finalized — verified program result", unavailable: "Unavailable — no award" }[state] ?? "Unavailable — no award";
}

function verificationLabel(state, resultStatus) {
  if (state === "queued") return "pending-computation-no-award";
  if (state === "unavailable") return "unavailable-no-award";
  if (state === "finalized" && resultStatus === null) return "finalized-with-invalid-result-status-no-award";
  if (state === "finalized" && resultStatus !== 0) return "finalized-with-nonzero-result-status-no-award";
  return "not-finalized-no-award";
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
