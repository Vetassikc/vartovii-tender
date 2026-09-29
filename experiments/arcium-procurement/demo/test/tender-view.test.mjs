import assert from "node:assert/strict";
import test from "node:test";
import { PublicKey } from "@solana/web3.js";
import { projectTenderFromAccount } from "../server/adapter.mjs";
import { actionCopy, buyerReadoutModel, isTrustedAward, tenderLifecycleRailModel } from "../src/tender-view.mjs";

const programId = new PublicKey("5ZmtkAKZ3Da8PeoeCcC8S7Wcec8VthjomvzvihUKzK1W");
const tenderId = Buffer.alloc(16, 12);
const [tender] = PublicKey.findProgramAddressSync([Buffer.from("tender"), tenderId], programId);

test("actual projected DTO and buyer view agree on canonical finalized allocation", () => {
  const projected = projectTenderFromAccount(tender, syntheticTenderAccount(3, 0));
  const readout = buyerReadoutModel(projected);

  assert.equal(projected.resultStatus, 0);
  assert.deepEqual(projected.award, { lot0Supplier: 2, lot1Supplier: 0, lot0Price: 45, lot1Price: 40, total: 85 });
  assert.equal(isTrustedAward(projected), true);
  assert.equal(readout.trusted, true);
  assert.equal(readout.title, actionCopy(projected));
  assert.match(readout.title, /verified/i);
  assert.equal(readout.noAward, null);
});

test("actual projected DTO rejects nonzero, queued, missing, and malformed result status", () => {
  const nonzero = projectTenderFromAccount(tender, syntheticTenderAccount(3, 1));
  assert.equal(buyerReadoutModel(nonzero).trusted, false);
  assert.match(actionCopy(nonzero), /without a valid allocation/i);

  const queued = projectTenderFromAccount(tender, syntheticTenderAccount(2, 0));
  assert.equal(buyerReadoutModel(queued).trusted, false);
  assert.match(actionCopy(queued), /pending/i);
  assert.equal(queued.resultStatus, 0);

  const projected = projectTenderFromAccount(tender, syntheticTenderAccount(3, 0));
  const { resultStatus: _missing, ...missing } = projected;
  assert.equal(isTrustedAward(missing), false);
  assert.match(actionCopy(missing), /numeric result status/i);
  const malformedProjected = projectTenderFromAccount(tender, syntheticTenderAccount(3, "0"));
  assert.equal(malformedProjected.resultStatus, null);
  assert.equal(isTrustedAward(malformedProjected), false);
  assert.equal(isTrustedAward({ ...projected, resultStatus: "0" }), false);
  assert.equal(isTrustedAward({ ...projected, resultStatus: null }), false);
  assert.equal(isTrustedAward({ ...projected, resultStatus: Number.NaN }), false);
});

test("buyer receipt identifies the tender, commitment, account read, award, and verification boundary", () => {
  const projected = projectTenderFromAccount(tender, syntheticTenderAccount(3, 0));
  const receipt = buyerReadoutModel(projected);

  assert.equal(receipt.tender, tender.toBase58());
  assert.equal(receipt.commitment, "01".repeat(32));
  assert.equal(receipt.accountState, "finalized");
  assert.equal(receipt.resultStatus, 0);
  assert.equal(receipt.bidCount, 3);
  assert.equal(receipt.accountReadAt, projected.timestamps.readAt);
  assert.deepEqual(receipt.award, {
    lot0Supplier: 2,
    lot1Supplier: 0,
    lot0Price: 45,
    lot1Price: 40,
    total: 85,
  });
  assert.match(receipt.accountVerification, /finalized tender account.*result status 0/i);
  assert.match(receipt.callbackProvenance, /does not check callback transaction history for this Tender/i);
  assert.match(receipt.callbackProvenance, /separate synthetic B3 run.*independently reviewed callback evidence/i);
  assert.match(receipt.verificationLimit, /synthetic local data/i);
  assert.match(receipt.verificationLimit, /one completed B3 run/i);
  assert.match(receipt.verificationLimit, /B2 adversarial integrity.*repeatability/i);
  assert.match(receipt.verificationLimit, /No devnet, production, customer-use, or independent-trust claim/i);
});

test("buyer receipt never includes an award for queued, unavailable, nonzero, or malformed status", () => {
  const cases = [
    ["queued", syntheticTenderAccount(2, 0), 0],
    ["unavailable", syntheticTenderAccount(4, 0), 0],
    ["nonzero result status", syntheticTenderAccount(3, 1), 1],
    ["malformed result status", syntheticTenderAccount(3, "0"), null],
  ];

  for (const [label, account, resultStatus] of cases) {
    const receipt = buyerReadoutModel(projectTenderFromAccount(tender, account));
    assert.equal(receipt.award, null, `${label} must not show an award`);
    assert.equal(receipt.resultStatus, resultStatus, `${label} must report its account result status safely`);
  }
});

test("lifecycle rail stays neutral without an account read and follows known state", () => {
  const unavailable = tenderLifecycleRailModel(null);
  assert.deepEqual(unavailable.map(({ active }) => active), [false, false, false, false]);
  assert.deepEqual(unavailable.map(({ current }) => current), [false, false, false, false]);

  const queued = tenderLifecycleRailModel({ state: "queued" });
  assert.deepEqual(queued.map(({ active }) => active), [true, true, true, false]);
  assert.deepEqual(queued.map(({ current }) => current), [false, false, true, false]);
});

function syntheticTenderAccount(state, resultStatus) {
  return {
    tenderId,
    deadline: 4102444800,
    state,
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
