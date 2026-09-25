import assert from "node:assert/strict";
import { test } from "node:test";

import {
  B2_STATE,
  canonicalBidMessage,
  canonicalCommitment,
  canonicalCommitmentBytes,
  createTender,
  submitBid,
  freezeTender,
  queueTender,
  applyVerifiedResult,
} from "./b2-integrity.mjs";

const PROGRAM_ID = "Program1111111111111111111111111111111111111";
const TENDER_ID = "tender-420";
const INVITED = ["supplier-a", "supplier-b", "supplier-c"];
const BIDS = INVITED.map((supplier, slot) => ({
  supplier,
  slot,
  ciphertexts: [
    Buffer.alloc(32, slot + 1),
    Buffer.alloc(32, slot + 11),
    Buffer.alloc(32, slot + 21),
  ],
  publicKey: Buffer.alloc(32, slot + 31),
  nonce: BigInt(slot + 1),
  signatureValid: true,
}));

const GOLDEN_COMMITMENT_INPUT = {
  programId: Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex"
  ),
  tenderId: Buffer.from(
    "202122232425262728292a2b2c2d2e2f",
    "hex"
  ),
  invited: [
    Buffer.alloc(32, 0x31),
    Buffer.alloc(32, 0x32),
    Buffer.alloc(32, 0x33),
  ],
  deadline: 1_700_000_000,
  policyVersion: 7,
  computationVersion: 9,
  bids: [0, 1, 2].map((slot) => ({
    supplier: `supplier-${slot}-is-not-encoded`,
    slot,
    ciphertexts: [
      Buffer.alloc(32, 0x41 + slot),
      Buffer.alloc(32, 0x51 + slot),
      Buffer.alloc(32, 0x61 + slot),
    ],
    publicKey: Buffer.alloc(32, 0x71 + slot),
    nonce: BigInt(0x100 + slot),
  })),
};

const GOLDEN_COMMITMENT_BODY_HEX = Buffer.concat([
  Buffer.from(
    "766172746f7669692d62322d74656e6465722d636f6d6d69746d656e742d7631",
    "hex"
  ),
  Buffer.from(
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "hex"
  ),
  Buffer.from("202122232425262728292a2b2c2d2e2f", "hex"),
  Buffer.alloc(32, 0x31),
  Buffer.alloc(32, 0x32),
  Buffer.alloc(32, 0x33),
  Buffer.from("00f1536500000000", "hex"),
  Buffer.from("07000000", "hex"),
  Buffer.from("09000000", "hex"),
  Buffer.from([0]),
  Buffer.alloc(32, 0x41),
  Buffer.alloc(32, 0x51),
  Buffer.alloc(32, 0x61),
  Buffer.alloc(32, 0x71),
  Buffer.from("00010000000000000000000000000000", "hex"),
  Buffer.from([1]),
  Buffer.alloc(32, 0x42),
  Buffer.alloc(32, 0x52),
  Buffer.alloc(32, 0x62),
  Buffer.alloc(32, 0x72),
  Buffer.from("01010000000000000000000000000000", "hex"),
  Buffer.from([2]),
  Buffer.alloc(32, 0x43),
  Buffer.alloc(32, 0x53),
  Buffer.alloc(32, 0x63),
  Buffer.alloc(32, 0x73),
  Buffer.from("02010000000000000000000000000000", "hex"),
]).toString("hex");

const GOLDEN_COMMITMENT =
  "d8adeedd434bb875d6869796b954a9aa04daab302366f0166849105e54d71b79";

function makeTender(now = 1_000) {
  return createTender({
    programId: PROGRAM_ID,
    creator: "creator",
    tenderId: TENDER_ID,
    invited: INVITED,
    deadline: now + 100,
    policyVersion: 1,
    computationVersion: 1,
    now,
  });
}

function fillTender(tender, now = 1_000) {
  for (const bid of BIDS) submitBid(tender, { ...bid, now });
}

test("requires three distinct invited suppliers at tender creation", () => {
  assert.throws(
    () =>
      createTender({
        programId: PROGRAM_ID,
        creator: "creator",
        tenderId: TENDER_ID,
        invited: ["supplier-a", "supplier-a", "supplier-c"],
        deadline: 2_000,
        policyVersion: 1,
        computationVersion: 1,
        now: 1_000,
      }),
    /distinct invited suppliers/
  );
});

test("canonical supplier message and frozen commitment bind all tender inputs", () => {
  const message = canonicalBidMessage({
    programId: PROGRAM_ID,
    tenderId: TENDER_ID,
    deadline: 1_100,
    policyVersion: 1,
    computationVersion: 1,
    ...BIDS[0],
  });
  assert.equal(message.length, 32 + 16 + 1 + 8 + 4 + 4 + 96 + 32 + 16);

  const tender = makeTender();
  fillTender(tender);
  const frozen = freezeTender(tender, { now: 1_000 });
  assert.equal(frozen.state, B2_STATE.FROZEN);
  assert.equal(frozen.commitment.length, 64);
  assert.equal(
    frozen.commitment,
    canonicalCommitment({
      programId: PROGRAM_ID,
      tenderId: TENDER_ID,
      invited: INVITED,
      deadline: 1_100,
      policyVersion: 1,
      computationVersion: 1,
      bids: BIDS,
    })
  );
});

test("uses the Rust-compatible commitment byte and digest golden vector", () => {
  const body = canonicalCommitmentBytes(GOLDEN_COMMITMENT_INPUT);
  assert.equal(body.toString("hex"), GOLDEN_COMMITMENT_BODY_HEX);
  assert.equal(
    canonicalCommitment(GOLDEN_COMMITMENT_INPUT),
    GOLDEN_COMMITMENT
  );
});

test("rejects outsider, slot substitution, duplicate and late bids without mutation", () => {
  const tender = makeTender();
  const before = JSON.stringify(tender);

  assert.throws(
    () => submitBid(tender, { ...BIDS[0], supplier: "outsider", now: 1_000 }),
    /supplier is not invited/
  );
  assert.equal(JSON.stringify(tender), before);

  assert.throws(
    () => submitBid(tender, { ...BIDS[0], slot: 1, now: 1_000 }),
    /supplier does not match slot/
  );
  assert.equal(JSON.stringify(tender), before);

  submitBid(tender, { ...BIDS[0], now: 1_000 });
  const afterFirst = JSON.stringify(tender);
  assert.throws(
    () => submitBid(tender, { ...BIDS[0], now: 1_000 }),
    /duplicate bid/
  );
  assert.equal(JSON.stringify(tender), afterFirst);

  assert.throws(
    () => submitBid(tender, { ...BIDS[1], now: 1_100 }),
    /deadline has passed/
  );
  assert.equal(JSON.stringify(tender), afterFirst);
});

test("freezes only a complete bid set and rejects every post-freeze edit", () => {
  const incomplete = makeTender();
  submitBid(incomplete, { ...BIDS[0], now: 1_000 });
  assert.throws(() => freezeTender(incomplete, { now: 1_000 }), /three bids/);

  const tender = makeTender();
  fillTender(tender);
  const frozen = freezeTender(tender, { now: 1_101 });
  const snapshot = JSON.stringify(frozen);
  assert.throws(
    () => submitBid(tender, { ...BIDS[0], now: 1_000 }),
    /tender is not open/
  );
  assert.throws(() => freezeTender(tender, { now: 1_000 }), /already frozen/);
  assert.equal(JSON.stringify(tender), snapshot);
});

test("queues one fixed computation only from the frozen snapshot", () => {
  const tender = makeTender();
  fillTender(tender);
  freezeTender(tender, { now: 1_000 });
  const snapshot = tender.commitment;
  queueTender(tender, {
    computationOffset: 420,
    computationAccount: "computation-420",
  });
  assert.equal(tender.state, B2_STATE.QUEUED);
  assert.equal(tender.commitment, snapshot);
  assert.throws(
    () => queueTender(tender, { computationOffset: 421, computationAccount: "replacement" }),
    /already queued/
  );
  assert.equal(tender.commitment, snapshot);
});

test("applies a verified result exactly once and records no-award terminal state", () => {
  const tender = makeTender();
  fillTender(tender);
  freezeTender(tender, { now: 1_000 });
  queueTender(tender, {
    computationOffset: 420,
    computationAccount: "computation-420",
  });
  const before = tender.commitment;
  applyVerifiedResult(tender, {
    computationAccount: "computation-420",
    verified: true,
    result: {
      status: "no_feasible",
      winners: [3, 3],
      winningPrices: [0, 0],
      total: 0,
    },
  });
  assert.equal(tender.state, B2_STATE.FINALIZED);
  assert.equal(tender.result.status, "no_feasible");
  assert.equal(tender.commitment, before);

  const after = JSON.stringify(tender);
  assert.throws(
    () =>
      applyVerifiedResult(tender, {
        computationAccount: "computation-420",
        verified: true,
        result: {
          status: "valid",
          winners: [2, 0],
          winningPrices: [45, 40],
          total: 85,
        },
      }),
    /result already applied/
  );
  assert.equal(JSON.stringify(tender), after);
});
