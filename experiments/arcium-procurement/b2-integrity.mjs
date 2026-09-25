import { createHash } from "node:crypto";

export const B2_STATE = Object.freeze({
  OPEN: "open",
  FROZEN: "frozen",
  QUEUED: "queued",
  FINALIZED: "finalized",
  FAILED: "failed",
});

const SLOT_COUNT = 3;

function fixedBytes(value, length) {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    if (value.length !== length) {
      throw new Error(`expected ${length} bytes`);
    }
    return Buffer.from(value);
  }
  const digest = createHash("sha256").update(String(value)).digest();
  return digest.subarray(0, length);
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(Number(value));
  return bytes;
}

function int64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(BigInt(value));
  return bytes;
}

function uint128(value) {
  const bytes = Buffer.alloc(16);
  let remaining = BigInt(value);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function normalizeBid(bid) {
  return {
    supplier: bid.supplier,
    slot: Number(bid.slot),
    ciphertexts: bid.ciphertexts.map((ciphertext) => fixedBytes(ciphertext, 32)),
    publicKey: fixedBytes(bid.publicKey, 32),
    nonce: BigInt(bid.nonce).toString(),
  };
}

export function canonicalBidMessage({
  programId,
  tenderId,
  deadline,
  policyVersion,
  computationVersion,
  slot,
  ciphertexts,
  publicKey,
  nonce,
}) {
  return Buffer.concat([
    fixedBytes(programId, 32),
    fixedBytes(tenderId, 16),
    Buffer.from([Number(slot)]),
    int64(deadline),
    uint32(policyVersion),
    uint32(computationVersion),
    ...ciphertexts.map((ciphertext) => fixedBytes(ciphertext, 32)),
    fixedBytes(publicKey, 32),
    uint128(nonce),
  ]);
}

export function canonicalCommitmentBytes({
  programId,
  tenderId,
  invited,
  deadline,
  policyVersion,
  computationVersion,
  bids,
}) {
  const body = Buffer.concat([
    Buffer.from("vartovii-b2-tender-commitment-v1", "utf8"),
    fixedBytes(programId, 32),
    fixedBytes(tenderId, 16),
    ...invited.map((supplier) => fixedBytes(supplier, 32)),
    int64(deadline),
    uint32(policyVersion),
    uint32(computationVersion),
    ...bids.flatMap((bid, slot) => [
      Buffer.from([slot]),
      ...bid.ciphertexts.map((ciphertext) => fixedBytes(ciphertext, 32)),
      fixedBytes(bid.publicKey, 32),
      uint128(bid.nonce),
    ]),
  ]);
  return body;
}

export function canonicalCommitment(args) {
  return createHash("sha256")
    .update(canonicalCommitmentBytes(args))
    .digest("hex");
}

export function createTender({
  programId,
  creator,
  tenderId,
  invited,
  deadline,
  policyVersion,
  computationVersion,
  now,
}) {
  if (!Array.isArray(invited) || invited.length !== SLOT_COUNT) {
    throw new Error("exactly three invited suppliers are required");
  }
  if (new Set(invited).size !== SLOT_COUNT) {
    throw new Error("distinct invited suppliers are required");
  }
  if (Number(deadline) <= Number(now)) {
    throw new Error("deadline must be in the future");
  }
  return {
    programId,
    creator,
    tenderId,
    invited: [...invited],
    deadline: Number(deadline),
    policyVersion: Number(policyVersion),
    computationVersion: Number(computationVersion),
    state: B2_STATE.OPEN,
    bids: [null, null, null],
    commitment: null,
    computationOffset: null,
    computationAccount: null,
    result: null,
  };
}

export function submitBid(tender, bid) {
  if (tender.state !== B2_STATE.OPEN) {
    throw new Error("tender is not open");
  }
  if (Number(bid.now) >= tender.deadline) {
    throw new Error("deadline has passed");
  }
  if (!Number.isInteger(bid.slot) || bid.slot < 0 || bid.slot >= SLOT_COUNT) {
    throw new Error("invalid supplier slot");
  }
  if (!tender.invited.includes(bid.supplier)) {
    throw new Error("supplier is not invited");
  }
  if (tender.invited[bid.slot] !== bid.supplier) {
    throw new Error("supplier does not match slot");
  }
  if (!bid.signatureValid) {
    throw new Error("supplier signature is invalid");
  }
  if (tender.bids[bid.slot] !== null) {
    throw new Error("duplicate bid");
  }
  tender.bids[bid.slot] = normalizeBid(bid);
  return tender;
}

export function freezeTender(tender, { now }) {
  if (tender.state === B2_STATE.FROZEN) {
    throw new Error("tender is already frozen");
  }
  if (tender.state !== B2_STATE.OPEN) {
    throw new Error("tender is not open");
  }
  if (!tender.bids.every(Boolean)) {
    throw new Error("freeze requires three bids");
  }
  // The deadline gates bid admission. A complete set admitted before it may
  // be frozen afterwards without changing the authenticated snapshot.
  tender.commitment = canonicalCommitment({
    programId: tender.programId,
    tenderId: tender.tenderId,
    invited: tender.invited,
    deadline: tender.deadline,
    policyVersion: tender.policyVersion,
    computationVersion: tender.computationVersion,
    bids: tender.bids,
  });
  tender.state = B2_STATE.FROZEN;
  return tender;
}

export function queueTender(tender, { computationOffset, computationAccount }) {
  if (tender.state !== B2_STATE.FROZEN) {
    if (tender.state === B2_STATE.QUEUED) {
      throw new Error("tender is already queued");
    }
    throw new Error("tender must be frozen");
  }
  if (!Number.isInteger(computationOffset) || computationOffset <= 0) {
    throw new Error("invalid computation offset");
  }
  tender.computationOffset = computationOffset;
  tender.computationAccount = computationAccount;
  tender.state = B2_STATE.QUEUED;
  return tender;
}

export function applyVerifiedResult(tender, { computationAccount, verified, result }) {
  if (tender.state === B2_STATE.FINALIZED) {
    throw new Error("result already applied");
  }
  if (tender.state !== B2_STATE.QUEUED) {
    throw new Error("tender is not queued");
  }
  if (tender.computationAccount !== computationAccount) {
    throw new Error("computation account does not match tender");
  }
  if (!verified) {
    throw new Error("computation output is not verified");
  }
  tender.result = {
    status: result.status,
    winners: [...result.winners],
    winningPrices: [...result.winningPrices],
    total: result.total,
  };
  tender.state = B2_STATE.FINALIZED;
  return tender;
}
