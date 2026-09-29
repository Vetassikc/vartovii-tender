import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import * as anchor from "@anchor-lang/core";
import * as adapter from "../server/adapter.mjs";
import * as server from "../server.mjs";

const tenderIdl = JSON.parse(fs.readFileSync(
  new URL("../../../../.runtime/arcium-spike/b2/tender/target/idl/tender.json", import.meta.url),
  "utf8"
));

test("queue offset is accepted by the pinned queue builder as a little-endian u64", async () => {
  const offset = adapter.createQueueTenderOffset(Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]));
  const payer = anchor.web3.SystemProgram.programId;
  const program = new anchor.Program(tenderIdl, { publicKey: payer });
  const instruction = await program.methods
    .queueTender(Array.from({ length: 16 }, (_, index) => index), offset)
    .accountsPartial({
      tender: payer,
      payer,
      computationAccount: payer,
      clusterAccount: payer,
      mxeAccount: payer,
      mempoolAccount: payer,
      executingPool: payer,
      compDefAccount: payer,
    })
    .instruction();
  const decoded = program.coder.instruction.decode(instruction.data);

  assert.equal(decoded.name, "queueTender");
  assert.equal(decoded.data.computationOffset.toString(), "1");
  assert.equal(instruction.keys.length, 13);
});

test("AnchorProvider signing failure after partialSign is classified as uncertain", async () => {
  const buyer = anchor.web3.Keypair.generate();
  let stage = "pre_sign";
  const wallet = adapter.observeTenderCreateWallet({
    publicKey: buyer.publicKey,
    async signTransaction(transaction) {
      const buyerSignature = transaction.signatures.find(({ publicKey }) =>
        publicKey.equals(buyer.publicKey)
      )?.signature;
      assert.ok(buyerSignature, "AnchorProvider should partialSign before calling the wallet");
      throw new Error("synthetic wallet failure after provider partialSign");
    },
  }, (nextStage) => { stage = nextStage; });
  const provider = new anchor.AnchorProvider({
    async getLatestBlockhash() {
      return { blockhash: buyer.publicKey.toBase58(), lastValidBlockHeight: 1 };
    },
  }, wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  const transaction = new anchor.web3.Transaction().add(
    anchor.web3.SystemProgram.transfer({
      fromPubkey: buyer.publicKey,
      toPubkey: anchor.web3.SystemProgram.programId,
      lamports: 1,
    })
  );

  await assert.rejects(
    provider.sendAndConfirm(transaction, [buyer]),
    /synthetic wallet failure after provider partialSign/
  );
  assert.equal(stage, "signing_unknown");
});

test("the production Create RPC path is signed by the Anchor wallet without extra signers", async () => {
  const buyer = anchor.web3.Keypair.generate();
  const stages = [];
  let submittedTransaction;
  const connection = {
    async getLatestBlockhash() {
      return { blockhash: buyer.publicKey.toBase58(), lastValidBlockHeight: 1 };
    },
    async sendRawTransaction(rawTransaction) {
      submittedTransaction = anchor.web3.Transaction.from(rawTransaction);
      assert.equal(submittedTransaction.verifySignatures(true), true);
      return "synthetic-signature";
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  };
  const wallet = adapter.observeTenderCreateWallet(
    new anchor.Wallet(buyer),
    (stage) => stages.push(stage)
  );
  const provider = new anchor.AnchorProvider(
    adapter.observeTenderCreateConnection(connection, (stage) => stages.push(stage)),
    wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  const sendAndConfirm = provider.sendAndConfirm.bind(provider);
  provider.sendAndConfirm = async (transaction, signers, options) => {
    assert.deepEqual(signers, []);
    return sendAndConfirm(transaction, signers, options);
  };
  const program = new anchor.Program(tenderIdl, provider);

  const signature = await adapter.submitTenderCreate(program, {
    tenderId: Array.from({ length: 16 }, (_, index) => index),
    invited: [buyer.publicKey, buyer.publicKey, buyer.publicKey],
    deadline: 1,
    creator: buyer.publicKey,
  });

  assert.equal(signature, "synthetic-signature");
  assert.ok(submittedTransaction);
  assert.ok(submittedTransaction.signatures.some(({ publicKey, signature: value }) =>
    publicKey.equals(buyer.publicKey) && value !== null
  ));
  assert.deepEqual(stages, [
    "signing_unknown",
    "signed_unsubmitted",
    "submission_unknown",
    "submitted_unconfirmed",
    "post_confirmation",
  ]);
});

test("Create observers mark signing, submission, and confirmation boundaries", async () => {
  assert.equal(typeof adapter.observeTenderCreateWallet, "function");
  assert.equal(typeof adapter.observeTenderCreateConnection, "function");
  const stages = [];
  const markStage = (stage) => stages.push(stage);

  const wallet = adapter.observeTenderCreateWallet({
    publicKey: "synthetic-public-key",
    async signTransaction(transaction) {
      return { ...transaction, signed: true };
    },
    async signAllTransactions(transactions) {
      return transactions.map((transaction) => ({ ...transaction, signed: true }));
    },
  }, markStage);
  const connection = adapter.observeTenderCreateConnection({
    async sendRawTransaction() {
      return "synthetic-signature";
    },
    async confirmTransaction() {
      return { value: { err: null } };
    },
  }, markStage);

  await wallet.signTransaction({ message: "synthetic" });
  await connection.sendRawTransaction(Buffer.from("synthetic"));
  await connection.confirmTransaction("synthetic-signature");

  assert.deepEqual(stages, [
    "signing_unknown",
    "signed_unsubmitted",
    "submission_unknown",
    "submitted_unconfirmed",
    "post_confirmation",
  ]);
});

test("a send error without a returned signature stays submission-unknown", async () => {
  assert.equal(typeof adapter.observeTenderCreateConnection, "function");
  const stages = [];
  const connection = adapter.observeTenderCreateConnection({
    async sendRawTransaction() {
      throw new Error("transport detail must not be recorded");
    },
    async confirmTransaction() {
      throw new Error("must not be called");
    },
  }, (stage) => stages.push(stage));

  await assert.rejects(connection.sendRawTransaction(Buffer.from("synthetic")), /transport detail/);
  assert.deepEqual(stages, ["submission_unknown"]);
});

test("a confirmation error after signature retains submitted-unconfirmed status", async () => {
  assert.equal(typeof adapter.observeTenderCreateConnection, "function");
  const stages = [];
  const connection = adapter.observeTenderCreateConnection({
    async sendRawTransaction() {
      return "synthetic-signature";
    },
    async confirmTransaction() {
      throw new Error("confirmation detail must not be recorded");
    },
  }, (stage) => stages.push(stage));

  const signature = await connection.sendRawTransaction(Buffer.from("synthetic"));
  await assert.rejects(connection.confirmTransaction(signature), /confirmation detail/);
  assert.deepEqual(stages, ["submission_unknown", "submitted_unconfirmed"]);
});

test("a confirmed transaction error is distinct from an unconfirmed submission", async () => {
  assert.equal(typeof adapter.observeTenderCreateConnection, "function");
  const stages = [];
  const connection = adapter.observeTenderCreateConnection({
    async sendRawTransaction() {
      return "synthetic-signature";
    },
    async confirmTransaction() {
      return { value: { err: { InstructionError: [0, "Custom"] } } };
    },
  }, (stage) => stages.push(stage));

  const signature = await connection.sendRawTransaction(Buffer.from("synthetic"));
  await connection.confirmTransaction(signature);
  assert.deepEqual(stages, ["submission_unknown", "submitted_unconfirmed", "confirmed_failure"]);
});

test("API failure payload carries only the safe stage, not cause details", () => {
  assert.equal(typeof adapter.TenderCreationFailure, "function");
  assert.equal(typeof server.apiErrorPayload, "function");
  const failure = new adapter.TenderCreationFailure("post_confirmation");

  assert.equal(failure.message, "Tender creation failed.");
  assert.equal(failure.cause, undefined);
  assert.deepEqual(server.apiErrorPayload(failure), {
    error: "Tender creation failed.",
    stage: "post_confirmation",
  });
});
