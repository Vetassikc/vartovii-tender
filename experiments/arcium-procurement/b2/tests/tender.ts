import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import {
  Ed25519Program,
  Keypair,
  MessageV0,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { expect } from "chai";
import {
  awaitComputationFinalization,
  getArciumAccountBaseSeed,
  getArciumSignerAccAddress,
  getArciumEnv,
  getArciumProgram,
  getArciumProgramId,
  getClusterAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getComputationAccAddress,
  getExecutingPoolAccAddress,
  getFeePoolAccAddress,
  getClockAccAddress,
  getLookupTableAddress,
  getMempoolAccAddress,
  getMXEAccAddress,
  getMXEPublicKey,
  deserializeLE,
  uploadCircuit,
  RescueCipher,
  x25519,
} from "@arcium-hq/client";
import { Tender } from "../target/types/tender";

declare const require: any;
const { solveAllocation } = require("../../../../../experiments/arcium-procurement/oracle.cjs");

const KEYPAIR_PATH = requiredEnvironmentPath("ARCIUM_B2_KEYPAIR");
const TRANSCRIPT_PATH = outputPath(
  "ARCIUM_B2_TRANSCRIPT",
  "transcript/tender-results.json"
);
const REMAINING_TRANSCRIPT_PATH = outputPath(
  "ARCIUM_B2_REMAINING_TRANSCRIPT",
  "transcript/tender-results-remaining.json"
);
const V0_TRANSCRIPT_PATH = outputPath(
  "ARCIUM_B2_V0_TRANSCRIPT",
  "transcript/tender-results-v0-2026-09-22.json"
);

function requiredEnvironmentPath(name: string): string {
  const configuredPath = process.env[name];
  if (configuredPath) return configuredPath;
  throw new Error(
    `Missing required ${name}; set it to a key file under an explicitly disposable B2 runtime before loading tests.`
  );
}

function outputPath(name: string, relativePath: string): string {
  const configuredPath = process.env[name];
  if (configuredPath) return configuredPath;

  const runtimeDirectory = process.env.ARCIUM_B2_DISPOSABLE_RUNTIME_DIR;
  if (!runtimeDirectory) {
    throw new Error(
      `Missing ${name}; set it explicitly or set ARCIUM_B2_DISPOSABLE_RUNTIME_DIR to a disposable runtime directory.`
    );
  }
  if (!path.isAbsolute(runtimeDirectory)) {
    throw new Error(
      "ARCIUM_B2_DISPOSABLE_RUNTIME_DIR must be an absolute path."
    );
  }
  return path.join(runtimeDirectory, relativePath);
}

type Fixture = {
  name: string;
  prices: number[][];
  capacities: number[];
};

type PreparedBid = {
  supplier: Keypair;
  slot: number;
  ciphertexts: Uint8Array[];
  publicKey: Uint8Array;
  nonce: bigint;
  signature: Uint8Array;
  message: Uint8Array;
};

const CANONICAL: Fixture = {
  name: "canonical",
  prices: [
    [40, 40],
    [55, 50],
    [45, 60],
  ],
  capacities: [1, 2, 1],
};

let program: Program<Tender>;
let provider: anchor.AnchorProvider;
let clusterAccount: PublicKey;
let owner: anchor.web3.Keypair;
let mxePublicKey: Uint8Array;

describe("B2 tender-bound encrypted allocation", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  program = anchor.workspace.Tender as Program<Tender>;
  provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumEnv = getArciumEnv();
  clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);
  owner = readKpJson(KEYPAIR_PATH);

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(
    eventName: E,
    timeoutMs = 120000
  ): Promise<Event[E]> => {
    let listenerId: number;
    let timeoutId: NodeJS.Timeout;
    const event = await new Promise<Event[E]>((resolve, reject) => {
      listenerId = program.addEventListener(eventName, (receivedEvent) => {
        clearTimeout(timeoutId);
        resolve(receivedEvent);
      });
      timeoutId = setTimeout(() => {
        program.removeEventListener(listenerId);
        reject(new Error("Event " + String(eventName) + " timed out"));
      }, timeoutMs);
    });
    await program.removeEventListener(listenerId);
    return event;
  };

  before(async () => {
    mxePublicKey = await getMXEPublicKeyWithRetry(
      provider,
      program.programId
    );
    await initAllocateCompDef(program, owner);
  });

  it("freezes three signed supplier bids and persists the verified C+A=85 result", async () => {
    const suppliers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await Promise.all(suppliers.map((supplier) => fund(supplier)));
    const tenderId = id16("b2-canonical-4");
    const deadline = nowUnix() + 120;
    const tender = await createTender(tenderId, suppliers, deadline);

    await expectRejectWithoutMutation(
      tender,
      () =>
        program.methods
          .freezeTender(Array.from(tenderId))
          .accounts({ tender, creator: owner.publicKey })
          .signers([owner])
          .rpc(),
      "IncompleteBidSet"
    );

    const prepared = suppliers.map((supplier, slot) =>
      prepareBid(supplier, slot, CANONICAL, tenderId, deadline)
    );
    for (const bid of prepared) await submitBid(tender, tenderId, bid);

    const beforeFreeze = publicState(await program.account.tender.fetch(tender));
    await program.methods
      .freezeTender(Array.from(tenderId))
      .accounts({ tender, creator: owner.publicKey })
      .signers([owner])
      .rpc();
    const frozen = publicState(await program.account.tender.fetch(tender));
    expect(frozen.state).to.equal(1);
    expect(frozen.bidCount).to.equal(3);
    expect(frozen.commitment).to.match(/^[0-9a-f]{64}$/);
    expect(frozen.bids).to.deep.equal(beforeFreeze.bids);
    const independentlyRecomputedCommitment = createHash("sha256")
      .update(
        canonicalCommitmentBytes(
          program.programId,
          tenderId,
          suppliers,
          deadline,
          prepared
        )
      )
      .digest("hex");
    expect(frozen.commitment).to.equal(independentlyRecomputedCommitment);

    const computationOffset = new anchor.BN(randomBytes(8), "le");
    const eventPromise = awaitEvent("allocationAppliedEvent");
    const queueSignature = await queueTender(tender, tenderId, computationOffset);
    const finalizeSignature = await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed"
    );
    const received = (await eventPromise) as any;
    const oracle = solveAllocation({
      prices: CANONICAL.prices,
      capacities: CANONICAL.capacities,
    });
    expect(Number(received.status)).to.equal(oracle.statusCode);
    expect([
      Number(received.lot0Supplier),
      Number(received.lot1Supplier),
    ]).to.deep.equal(oracle.winners);
    expect([
      Number(received.lot0Price),
      Number(received.lot1Price),
    ]).to.deep.equal(oracle.winningPrices);
    expect(received.total.toString()).to.equal(String(oracle.total));
    expect(received.tender.toBase58()).to.equal(tender.toBase58());

    const finalized = publicState(await program.account.tender.fetch(tender));
    expect(finalized.state).to.equal(3);
    expect(finalized.commitment).to.equal(frozen.commitment);
    expect(finalized.bids).to.deep.equal(frozen.bids);
    expect(finalized.result).to.deep.equal({
      status: 0,
      winners: [2, 0],
      winningPrices: [45, 40],
      total: 85,
    });

    fs.mkdirSync(path.dirname(TRANSCRIPT_PATH), { recursive: true });
    fs.writeFileSync(
      TRANSCRIPT_PATH,
      JSON.stringify(
        {
          kind: "b2-tender-bound-encrypted-allocation",
          disclosure:
            "supplier public keys, ciphertext digests, commitment, synthetic fixture prices and bounded award are recorded; the program output exposes only encrypted-input digests and the bounded result",
          syntheticFixture: CANONICAL,
          tender: tender.toBase58(),
          invitedSupplierPublicKeys: suppliers.map((supplier) =>
            supplier.publicKey.toBase58()
          ),
          frozenSnapshot: frozen,
          finalizedSnapshot: finalized,
          oracle,
          encryptedInputs: prepared.map((bid) => ({
            slot: bid.slot,
            ciphertextDigests: bid.ciphertexts.map((ciphertext) =>
              digest(ciphertext)
            ),
            encryptionPublicKey: Buffer.from(bid.publicKey).toString("hex"),
          })),
          callback: {
            status: Number(received.status),
            winners: [
              Number(received.lot0Supplier),
              Number(received.lot1Supplier),
            ],
            winningPrices: [
              Number(received.lot0Price),
              Number(received.lot1Price),
            ],
            total: Number(received.total),
          },
          queueSignature,
          finalizeSignature,
          verifiedPersistedState: true,
          signedCallbackReplay: "PENDING: not independently replayed",
          legitimateAbort: "PENDING: no trusted abort receipt was fabricated",
        },
        null,
        2
      ) + "\n"
    );
  });

  it("rejects participant and lifecycle substitutions on the validator path", async () => {
    const suppliers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const outsider = Keypair.generate();
    await Promise.all([...suppliers, outsider].map((signer) => fund(signer)));
    const tenderId = id16("b2-adversarial-4");
    const deadline = nowUnix() + 120;
    const tender = await createTender(tenderId, suppliers, deadline);

    const outsiderBid = prepareBid(outsider, 0, CANONICAL, tenderId, deadline);
    await expectRejectWithoutMutation(
      tender,
      () => submitBid(tender, tenderId, outsiderBid),
      "SupplierNotInvited"
    );

    const wrongSlotBid = prepareBid(
      suppliers[0],
      1,
      CANONICAL,
      tenderId,
      deadline
    );
    await expectRejectWithoutMutation(
      tender,
      () => submitBid(tender, tenderId, wrongSlotBid),
      "SupplierSlotMismatch"
    );

    const prepared = suppliers.map((supplier, slot) =>
      prepareBid(supplier, slot, CANONICAL, tenderId, deadline)
    );
    await submitBid(tender, tenderId, prepared[0]);
    await expectRejectWithoutMutation(
      tender,
      () => submitBid(tender, tenderId, prepared[0]),
      "DuplicateBid"
    );
    await expectRejectWithoutMutation(
      tender,
      () =>
        program.methods
          .freezeTender(Array.from(tenderId))
          .accounts({ tender, creator: owner.publicKey })
          .signers([owner])
          .rpc(),
      "IncompleteBidSet"
    );
    await submitBid(tender, tenderId, prepared[1]);
    await submitBid(tender, tenderId, prepared[2]);
    await program.methods
      .freezeTender(Array.from(tenderId))
      .accounts({ tender, creator: owner.publicKey })
      .signers([owner])
      .rpc();
    const frozen = publicState(await program.account.tender.fetch(tender));

    await expectRejectWithoutMutation(
      tender,
      () => submitBid(tender, tenderId, prepared[0]),
      "TenderNotOpen"
    );

    const computationOffset = new anchor.BN(randomBytes(8), "le");
    await queueTender(tender, tenderId, computationOffset);
    await expectRejectWithoutMutation(
      tender,
      () => queueTender(tender, tenderId, new anchor.BN(421)),
      "TenderAlreadyQueued"
    );
    const queued = publicState(await program.account.tender.fetch(tender));
    expect(queued.commitment).to.equal(frozen.commitment);
    expect(queued.bids).to.deep.equal(frozen.bids);

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed"
    );
  });

  it("rejects an invited bid after the validator deadline without mutation", async () => {
    const suppliers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await Promise.all(suppliers.map((supplier) => fund(supplier)));
    const tenderId = id16("b2-late-bid-1");
    const deadline = (await validatorUnix()) + 10;
    const tender = await createTender(tenderId, suppliers, deadline);
    const prepared = suppliers.map((supplier, slot) =>
      prepareBid(supplier, slot, CANONICAL, tenderId, deadline)
    );

    await submitBid(tender, tenderId, prepared[0]);
    await submitBid(tender, tenderId, prepared[1]);
    await waitUntilAfter(deadline);

    const before = publicState(await program.account.tender.fetch(tender));
    const rejection = await expectRejectWithoutMutation(
      tender,
      () => submitBid(tender, tenderId, prepared[2]),
      "DeadlinePassed"
    );
    const after = publicState(await program.account.tender.fetch(tender));
    recordRemainingCheck({
      check: "live-late-bid",
      tender: tender.toBase58(),
      deadline,
      stateBefore: before,
      stateAfter: after,
      rejection: rejectionCode(rejection),
      unchanged: JSON.stringify(before) === JSON.stringify(after),
    });
  });

  it("rejects a serialized forged callback before output verification", async () => {
    const suppliers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await Promise.all(suppliers.map((supplier) => fund(supplier)));
    const tenderId = id16("b2-forged-callback");
    const deadline = nowUnix() + 120;
    const tender = await createTender(tenderId, suppliers, deadline);
    const prepared = suppliers.map((supplier, slot) =>
      prepareBid(supplier, slot, CANONICAL, tenderId, deadline)
    );
    for (const bid of prepared) await submitBid(tender, tenderId, bid);
    await program.methods
      .freezeTender(Array.from(tenderId))
      .accounts({ tender, creator: owner.publicKey })
      .signers([owner])
      .rpc();

    const computationOffset = new anchor.BN(randomBytes(8), "le");
    await queueTender(tender, tenderId, computationOffset);
    const before = publicState(await program.account.tender.fetch(tender));
    const rejection = await expectRejectWithoutMutation(
      tender,
      () =>
        provider.sendAndConfirm(
          new anchor.web3.Transaction().add(
            allocateCallbackInstruction(tender, computationOffset)
          ),
          [],
          { commitment: "confirmed", skipPreflight: true }
        ),
      "InvalidCallbackTx"
    );
    const after = publicState(await program.account.tender.fetch(tender));
    recordRemainingCheck({
      check: "forged-callback",
      tender: tender.toBase58(),
      computationOffset: computationOffset.toString(),
      rejection: rejectionCode(rejection),
      stateBefore: before,
      stateAfter: after,
      unchanged: JSON.stringify(before) === JSON.stringify(after),
      layer:
        "Arcium callback transaction-structure guard; this is not output signature verification",
    });
  });

  it("records legacy and v0 queue packet sizes before sending", async () => {
    const suppliers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const tenderId = randomBytes(16);
    const deadline = nowUnix() + 120;
    const [callbackTender] = PublicKey.findProgramAddressSync(
      [Buffer.from("tender"), tenderId],
      program.programId
    );
    const prepared = suppliers.map((supplier, slot) =>
      prepareBid(supplier, slot, CANONICAL, tenderId, deadline)
    );
    const computationOffset = new anchor.BN(randomBytes(8), "le");
    const built = await buildRawAllocationQueueInstruction(
      prepared,
      computationOffset,
      callbackTender
    );
    const arciumProgram: any = getArciumProgram(provider);
    const mxeAddress = getMXEAccAddress(program.programId);
    const mxe = await arciumProgram.account.mxeAccount.fetch(mxeAddress);
    const lutAddress = getLookupTableAddress(
      program.programId,
      mxe.lutOffsetSlot
    );
    const lookupResult = await provider.connection.getAddressLookupTable(
      lutAddress
    );
    expect(lookupResult.value).to.not.equal(null);
    const lookupTable = lookupResult.value!;
    const latestBlockhash = await provider.connection.getLatestBlockhash(
      "confirmed"
    );

    const legacy = new Transaction({
      feePayer: owner.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
    }).add(built.instruction);
    legacy.partialSign(owner);
    const legacyMessageBytes = legacy.serializeMessage();
    let legacyBytes: Uint8Array | undefined;
    let legacySerializationError: string | undefined;
    try {
      legacyBytes = legacy.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
    } catch (error) {
      legacySerializationError = String(error);
    }
    const legacySerializedBytes =
      legacyBytes?.length ?? 1 + legacy.signatures.length * 64 + legacyMessageBytes.length;

    const v0Message = MessageV0.compile({
      payerKey: owner.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [built.instruction],
      addressLookupTableAccounts: [lookupTable],
    });
    const v0Transaction = new VersionedTransaction(v0Message);
    v0Transaction.sign([owner]);
    const v0Bytes = v0Transaction.serialize();

    const signSeed = getArciumSignerAccAddress(program.programId);
    const directInstruction = new TransactionInstruction({
      programId: built.instruction.programId,
      keys: built.instruction.keys.map((key) =>
        key.pubkey.equals(signSeed) ? { ...key, isSigner: false } : key
      ),
      data: built.instruction.data,
    });
    const directV0Message = MessageV0.compile({
      payerKey: owner.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [directInstruction],
      addressLookupTableAccounts: [lookupTable],
    });
    const directV0Transaction = new VersionedTransaction(directV0Message);
    directV0Transaction.sign([owner]);
    const directV0Bytes = directV0Transaction.serialize();

    writeV0Evidence({
      check: "v0-queue-size",
      computationOffset: computationOffset.toString(),
      callbackTender: callbackTender.toBase58(),
      mxeAddress: mxeAddress.toBase58(),
      mxeLutOffsetSlot: mxe.lutOffsetSlot.toString(),
      existingMxeAddressLookupTable: lutAddress.toBase58(),
      lookupTableAddresses: lookupTable.state.addresses.map((address) =>
        address.toBase58()
      ),
      instructionProgramId: built.instruction.programId.toBase58(),
      instructionDataBytes: built.instruction.data.length,
      instructionDataSha256: createHash("sha256")
        .update(built.instruction.data)
        .digest("hex"),
      instructionAccounts: built.instruction.keys.map((key) => ({
        pubkey: key.pubkey.toBase58(),
        isSigner: key.isSigner,
        isWritable: key.isWritable,
      })),
      argumentShape: {
        args: built.argsCount,
        byteArrays: built.byteArrayCount,
        values128Bit: built.values128BitCount,
        callbackAccounts: built.callbackAccountCount,
      },
      legacy: {
        signerCount: legacy.signatures.length,
        signatureBytes: legacy.signatures.length * 64,
        messageBytes: legacyMessageBytes.length,
        serializedBytes: legacySerializedBytes,
        serializationError: legacySerializationError ?? null,
        packetLimitBytes: 1232,
      },
      v0: {
        requiredSignerCount: v0Message.header.numRequiredSignatures,
        signedSigner: owner.publicKey.toBase58(),
        missingSignatureSlots: v0Transaction.signatures.filter((signature) =>
          signature.every((byte) => byte === 0)
        ).length,
        signatureBytes: v0Transaction.signatures.length * 64,
        messageBytes: v0Message.serialize().length,
        serializedBytes: v0Bytes.length,
        packetLimitBytes: 1232,
        addressTableLookups: v0Message.addressTableLookups.map((lookup) => ({
          accountKey: lookup.accountKey.toBase58(),
          writableIndexes: Array.from(lookup.writableIndexes),
          readonlyIndexes: Array.from(lookup.readonlyIndexes),
        })),
        resolvedAccounts: resolveV0Accounts(v0Message, lookupTable),
      },
      directV0: {
        signSeedRemovedFromTopLevelSignerSet: true,
        requiredSignerCount: directV0Message.header.numRequiredSignatures,
        signerCount: directV0Transaction.signatures.length,
        signatureBytes: directV0Transaction.signatures.length * 64,
        messageBytes: directV0Message.serialize().length,
        serializedBytes: directV0Bytes.length,
        packetLimitBytes: 1232,
        addressTableLookups: directV0Message.addressTableLookups.map((lookup) => ({
          accountKey: lookup.accountKey.toBase58(),
          writableIndexes: Array.from(lookup.writableIndexes),
          readonlyIndexes: Array.from(lookup.readonlyIndexes),
        })),
        resolvedAccounts: resolveV0Accounts(directV0Message, lookupTable),
      },
      sent: false,
      limitation:
        "Size evidence only; no transaction was sent and no wrong-context result is established by this check.",
    });
  });

  it("keeps a queued tender pending after a trusted computation failure", async () => {
    const suppliers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await Promise.all(suppliers.map((supplier) => fund(supplier)));
    const tenderId = id16("b2-trusted-abort");
    const deadline = nowUnix() + 120;
    const tender = await createTender(tenderId, suppliers, deadline);
    const prepared = suppliers.map((supplier, slot) =>
      prepareBid(supplier, slot, CANONICAL, tenderId, deadline)
    );

    prepared[0].ciphertexts[0] = new Uint8Array(32).fill(255);
    prepared[0].message = bidMessage(
      program.programId,
      tenderId,
      prepared[0].slot,
      deadline,
      prepared[0].ciphertexts,
      prepared[0].publicKey,
      prepared[0].nonce
    );
    prepared[0].signature = require("tweetnacl").sign.detached(
      prepared[0].message,
      prepared[0].supplier.secretKey
    );
    for (const bid of prepared) await submitBid(tender, tenderId, bid);
    await program.methods
      .freezeTender(Array.from(tenderId))
      .accounts({ tender, creator: owner.publicKey })
      .signers([owner])
      .rpc();

    const computationOffset = new anchor.BN(randomBytes(8), "le");
    await queueTender(tender, tenderId, computationOffset);
    const finalizationSignature = await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed",
      120000
    );
    const callback = await waitForTrustedAbortCallback(
      getComputationAccAddress(getArciumEnv().arciumClusterOffset, computationOffset),
      finalizationSignature
    );
    const after = publicState(await program.account.tender.fetch(tender));
    const callbackTransaction = callback.transaction;
    const callbackLogs = callbackTransaction?.meta?.logMessages?.join("\n") ?? "";
    recordRemainingCheck({
      check: "trusted-abort",
      tender: tender.toBase58(),
      computationOffset: computationOffset.toString(),
      finalizationSignature,
      callbackSignature: callback.signature,
      stateAfter: after,
      callbackError: callbackLogs.includes("AbortedComputation")
        ? "program-mapped-output-verification-failure"
        : "not-observed",
      callbackErrorCode: callbackLogs.includes("AbortedComputation")
        ? "AbortedComputation"
        : "not-observed",
      callbackFailureProvenance:
        "The tender program maps every verify_output error to AbortedComputation; an independent Arcium SignedComputationOutputs::Failure or abort reason was not captured.",
      callbackTransactionFailed: callbackTransaction?.meta?.err !== null,
      malformedInput: "encrypted field replaced with 0xff bytes",
    });
    expect(after.state).to.equal(2);
    expect(callbackTransaction?.meta?.err).to.not.equal(null);
    expect(callbackLogs).to.contain("AbortedComputation");
  });

  it("does not accept a successful action as a rejection", async () => {
    let helperError: unknown;
    try {
      await expectReject(async () => undefined, "SyntheticExpectedCode");
    } catch (error) {
      helperError = error;
    }
    expect(String(helperError)).to.contain("expected SyntheticExpectedCode");
  });
});

async function createTender(
  tenderId: Buffer,
  suppliers: Keypair[],
  deadline: number
): Promise<PublicKey> {
  const [tender] = PublicKey.findProgramAddressSync(
    [Buffer.from("tender"), tenderId],
    (anchor.workspace.Tender as Program<Tender>).programId
  );
  await (anchor.workspace.Tender as Program<Tender>).methods
    .createTender(
      Array.from(tenderId),
      suppliers.map((supplier) => supplier.publicKey),
      new anchor.BN(deadline)
    )
    .accounts({
      creator: ownerFromProvider().publicKey,
    })
    .signers([ownerFromProvider()])
    .rpc();
  return tender;
}

async function submitBid(
  tender: PublicKey,
  tenderId: Buffer,
  bid: PreparedBid
): Promise<string> {
  const program = anchor.workspace.Tender as Program<Tender>;
  const ed25519Instruction = Ed25519Program.createInstructionWithPublicKey({
    publicKey: bid.supplier.publicKey.toBytes(),
    message: bid.message,
    signature: bid.signature,
  });
  return program.methods
    .submitBid(
      Array.from(tenderId),
      bid.slot,
      bid.ciphertexts.map((ciphertext) => Array.from(ciphertext)),
      Array.from(bid.publicKey),
      new anchor.BN(bid.nonce.toString()),
      Array.from(bid.signature)
    )
    .accounts({
      supplier: bid.supplier.publicKey,
    })
    .preInstructions([ed25519Instruction])
    .signers([bid.supplier])
    .rpc();
}

async function queueTender(
  tender: PublicKey,
  tenderId: Buffer,
  computationOffset: anchor.BN
): Promise<string> {
  const program = anchor.workspace.Tender as Program<Tender>;
  const env = getArciumEnv();
  return program.methods
    .queueTender(Array.from(tenderId), computationOffset)
    .accountsPartial({
      tender,
      payer: ownerFromProvider().publicKey,
      computationAccount: getComputationAccAddress(
        env.arciumClusterOffset,
        computationOffset
      ),
      clusterAccount,
      mxeAccount: getMXEAccAddress(program.programId),
      mempoolAccount: getMempoolAccAddress(env.arciumClusterOffset),
      executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
      compDefAccount: getCompDefAccAddress(
        program.programId,
        Buffer.from(getCompDefAccOffset("allocate")).readUInt32LE()
      ),
    })
    .signers([ownerFromProvider()])
    .rpc({ skipPreflight: true, commitment: "confirmed" });
}

async function buildRawAllocationQueueInstruction(
  prepared: PreparedBid[],
  computationOffset: anchor.BN,
  callbackTender: PublicKey
): Promise<{
  instruction: TransactionInstruction;
  argsCount: number;
  byteArrayCount: number;
  values128BitCount: number;
  callbackAccountCount: number;
}> {
  const arciumProgram: any = getArciumProgram(provider);
  const env = getArciumEnv();
  const byteArrays: Buffer[] = [];
  const values128Bit: anchor.BN[] = [];
  const args: Record<string, number>[] = [];
  for (const bid of prepared) {
    args.push({ x25519Pubkey: byteArrays.length });
    byteArrays.push(Buffer.from(bid.publicKey));
    args.push({ plaintextU128: values128Bit.length });
    values128Bit.push(new anchor.BN(bid.nonce.toString()));
    for (const ciphertext of bid.ciphertexts) {
      args.push({
        [ciphertext.length === 1 ? "encryptedU8" : "encryptedU64"]:
          byteArrays.length,
      });
      byteArrays.push(Buffer.from(ciphertext));
    }
  }
  const callbackAccounts = allocateCallbackAccounts(
    callbackTender,
    computationOffset
  );
  const callbackInstruction = {
    programId: program.programId,
    discriminator: Buffer.from([205, 252, 248, 185, 201, 169, 234, 193]),
    accounts: Object.values(callbackAccounts).map((pubkey) => ({
      pubkey,
      isWritable: pubkey.equals(callbackTender),
    })),
  };
  const compDefOffset = Buffer.from(getCompDefAccOffset("allocate")).readUInt32LE();
  const instruction = await arciumProgram.methods
    .queueComputation(
      computationOffset,
      compDefOffset,
      {
        args,
        byteArrays,
        plaintextNumbers: [],
        values128Bit,
        accounts: [],
      },
      program.programId,
      [callbackInstruction],
      1,
      0,
      0,
      new anchor.BN(0)
    )
    .accountsPartial({
      signer: owner.publicKey,
      signSeed: getArciumSignerAccAddress(program.programId),
      comp: getComputationAccAddress(env.arciumClusterOffset, computationOffset),
      mxe: getMXEAccAddress(program.programId),
      executingPool: getExecutingPoolAccAddress(env.arciumClusterOffset),
      mempool: getMempoolAccAddress(env.arciumClusterOffset),
      compDefAcc: getCompDefAccAddress(program.programId, compDefOffset),
      cluster: clusterAccount,
      poolAccount: getFeePoolAccAddress(),
      systemProgram: SystemProgram.programId,
      clock: getClockAccAddress(),
    })
    .instruction();
  return {
    instruction,
    argsCount: args.length,
    byteArrayCount: byteArrays.length,
    values128BitCount: values128Bit.length,
    callbackAccountCount: callbackInstruction.accounts.length,
  };
}

function resolveV0Accounts(message: MessageV0, lookupTable: any): {
  static: string[];
  lookedUp: Array<{ index: number; pubkey: string; writable: boolean }>;
} {
  const lookedUp: Array<{ index: number; pubkey: string; writable: boolean }> = [];
  for (const lookup of message.addressTableLookups) {
    for (const index of lookup.writableIndexes) {
      lookedUp.push({
        index,
        pubkey: lookupTable.state.addresses[index].toBase58(),
        writable: true,
      });
    }
    for (const index of lookup.readonlyIndexes) {
      lookedUp.push({
        index,
        pubkey: lookupTable.state.addresses[index].toBase58(),
        writable: false,
      });
    }
  }
  return {
    static: message.staticAccountKeys.map((key) => key.toBase58()),
    lookedUp,
  };
}

function writeV0Evidence(evidence: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(V0_TRANSCRIPT_PATH), { recursive: true });
  fs.writeFileSync(
    V0_TRANSCRIPT_PATH,
    JSON.stringify({ kind: "b2-v0-queue-size", ...evidence }, null, 2) + "\n"
  );
}

function allocateCallbackAccounts(
  tender: PublicKey,
  computationOffset: anchor.BN
): Record<string, PublicKey> {
  const program = anchor.workspace.Tender as Program<Tender>;
  const env = getArciumEnv();
  return {
    arciumProgram: getArciumProgramId(),
    compDefAccount: getCompDefAccAddress(
      program.programId,
      Buffer.from(getCompDefAccOffset("allocate")).readUInt32LE()
    ),
    mxeAccount: getMXEAccAddress(program.programId),
    computationAccount: getComputationAccAddress(
      env.arciumClusterOffset,
      computationOffset
    ),
    clusterAccount,
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
    tender,
  };
}

function allocateCallbackInstruction(
  tender: PublicKey,
  computationOffset: anchor.BN
): TransactionInstruction {
  const accounts = allocateCallbackAccounts(tender, computationOffset);
  return new TransactionInstruction({
    programId: (anchor.workspace.Tender as Program<Tender>).programId,
    keys: [
      { pubkey: accounts.arciumProgram, isSigner: false, isWritable: false },
      { pubkey: accounts.compDefAccount, isSigner: false, isWritable: false },
      { pubkey: accounts.mxeAccount, isSigner: false, isWritable: false },
      { pubkey: accounts.computationAccount, isSigner: false, isWritable: false },
      { pubkey: accounts.clusterAccount, isSigner: false, isWritable: false },
      { pubkey: accounts.instructionsSysvar, isSigner: false, isWritable: false },
      { pubkey: accounts.tender, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      Buffer.from([205, 252, 248, 185, 201, 169, 234, 193]),
      Buffer.from([1]),
      Buffer.alloc(64),
    ]),
  });
}

function prepareBid(
  supplier: Keypair,
  slot: number,
  fixture: Fixture,
  tenderId: Buffer,
  deadline: number
): PreparedBid {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const nonceBytes = randomBytes(16);
  const nonce = deserializeLE(nonceBytes);
  const ciphertexts = cipher
    .encrypt(
      [
        BigInt(fixture.prices[slot][0]),
        BigInt(fixture.prices[slot][1]),
        BigInt(fixture.capacities[slot]),
      ],
      nonceBytes
    )
    .map((ciphertext) => Uint8Array.from(ciphertext));
  const message = bidMessage(
    program.programId,
    tenderId,
    slot,
    deadline,
    ciphertexts,
    publicKey,
    nonce
  );
  const signature = require("tweetnacl").sign.detached(
    message,
    supplier.secretKey
  );
  return {
    supplier,
    slot,
    ciphertexts,
    publicKey,
    nonce,
    signature,
    message,
  };
}

function bidMessage(
  programId: PublicKey,
  tenderId: Buffer,
  slot: number,
  deadline: number,
  ciphertexts: Uint8Array[],
  publicKey: Uint8Array,
  nonce: bigint
): Buffer {
  return Buffer.concat([
    programId.toBuffer(),
    tenderId,
    Buffer.from([slot]),
    i64le(deadline),
    u32le(1),
    u32le(1),
    ...ciphertexts.map((ciphertext) => Buffer.from(ciphertext)),
    Buffer.from(publicKey),
    u128le(nonce),
  ]);
}

function publicState(account: any): any {
  return {
    state: Number(account.state),
    bidCount: Number(account.bidCount),
    commitment: Buffer.from(account.commitment).toString("hex"),
    computationOffset: account.computationOffset.toString(),
    computationAccount: account.computationAccount.toBase58(),
    bids: account.bids.map((bid: any) => ({
      present: bid.present,
      ciphertextDigests: bid.ciphertexts.map((ciphertext: number[]) =>
        digest(ciphertext)
      ),
      encryptionPublicKey: Buffer.from(bid.encryptionPubkey).toString("hex"),
      nonce: bid.nonce.toString(),
    })),
    result: {
      status: Number(account.resultStatus),
      winners: [Number(account.lot0Supplier), Number(account.lot1Supplier)],
      winningPrices: [
        Number(account.lot0Price),
        Number(account.lot1Price),
      ],
      total: Number(account.total),
    },
  };
}

function canonicalCommitmentBytes(
  programId: PublicKey,
  tenderId: Buffer,
  invited: Keypair[],
  deadline: number,
  bids: PreparedBid[]
): Buffer {
  return Buffer.concat([
    Buffer.from("vartovii-b2-tender-commitment-v1", "utf8"),
    programId.toBytes(),
    tenderId,
    ...invited.map((supplier) => supplier.publicKey.toBytes()),
    i64le(deadline),
    u32le(1),
    u32le(1),
    ...bids.reduce<Buffer[]>(
      (segments, bid, slot) =>
        segments.concat([
          Buffer.from([slot]),
          ...bid.ciphertexts.map((ciphertext) => Buffer.from(ciphertext)),
          Buffer.from(bid.publicKey),
          u128le(bid.nonce),
        ]),
      []
    ),
  ]);
}

async function expectReject(
  action: () => Promise<unknown>,
  code: string
): Promise<string> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected " + code).to.not.equal(undefined);
  const text = errorText(caught);
  expect(text).to.contain(code);
  return text;
}

async function expectRejectWithoutMutation(
  tender: PublicKey,
  action: () => Promise<unknown>,
  code: string
): Promise<string> {
  const before = publicState(await program.account.tender.fetch(tender));
  const rejection = await expectReject(action, code);
  const after = publicState(await program.account.tender.fetch(tender));
  expect(after).to.deep.equal(before);
  return rejection;
}

function recordRemainingCheck(check: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(REMAINING_TRANSCRIPT_PATH), { recursive: true });
  let transcript: Record<string, unknown> = {
    kind: "b2-remaining-checks",
    checks: [],
  };
  if (fs.existsSync(REMAINING_TRANSCRIPT_PATH)) {
    transcript = JSON.parse(fs.readFileSync(REMAINING_TRANSCRIPT_PATH, "utf8"));
  }
  const checks = Array.isArray(transcript.checks) ? transcript.checks : [];
  checks.push(check);
  transcript.checks = checks;
  fs.writeFileSync(REMAINING_TRANSCRIPT_PATH, JSON.stringify(transcript, null, 2) + "\n");
}

function rejectionCode(value: string): string {
  const anchorCode = value.match(/Error Code:\s*([A-Za-z][A-Za-z0-9_]*)/);
  if (anchorCode?.[1]) return anchorCode[1];
  for (const code of ["DeadlinePassed", "InvalidCallbackTx"]) {
    if (value.includes(code)) return code;
  }
  return "recorded-rejection";
}

async function waitUntilAfter(deadline: number): Promise<void> {
  while (nowUnix() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function waitForTrustedAbortCallback(
  computationAccount: PublicKey,
  ignoredSignature: string,
  timeoutMs = 60000
): Promise<{ signature: string; transaction: any }> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const signatures = await provider.connection.getSignaturesForAddress(
      computationAccount,
      { limit: 20 },
      "confirmed"
    );
    for (const entry of signatures) {
      if (entry.signature === ignoredSignature) continue;
      const transaction = await provider.connection.getTransaction(
        entry.signature,
        { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
      );
      const logs = transaction?.meta?.logMessages?.join("\n") ?? "";
      if (logs.includes("AbortedComputation")) {
        return { signature: entry.signature, transaction };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Trusted abort callback was not observed within the bounded wait");
}

async function validatorUnix(): Promise<number> {
  const slot = await provider.connection.getSlot("confirmed");
  return (await provider.connection.getBlockTime(slot)) ?? nowUnix();
}

function errorText(error: unknown): string {
  const value = error as any;
  const pieces = [
    value?.error?.errorCode?.code,
    value?.errorCode?.code,
    value?.message,
    value?.error?.message,
    ...(Array.isArray(value?.logs) ? value.logs : []),
    ...(Array.isArray(value?.error?.logs) ? value.error.logs : []),
  ].filter((piece): piece is string => typeof piece === "string");
  try {
    pieces.push(JSON.stringify(error));
  } catch {
    // Keep the human-readable error text below when serialization is unsafe.
  }
  pieces.push(String(error));
  return pieces.join("\n");
}

async function fund(signer: Keypair): Promise<void> {
  const signature = await provider.connection.requestAirdrop(
    signer.publicKey,
    1_000_000_000
  );
  await provider.connection.confirmTransaction(signature, "confirmed");
}

function id16(value: string): Buffer {
  const result = Buffer.alloc(16);
  Buffer.from(value).copy(result, 0, 0, 16);
  return result;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

function digest(value: number[] | Uint8Array): string {
  return Buffer.from(value).toString("hex").slice(0, 16);
}

function i64le(value: number): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigInt64LE(BigInt(value));
  return result;
}

function u32le(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}

function u128le(value: bigint): Buffer {
  const result = Buffer.alloc(16);
  let remaining = value;
  for (let index = 0; index < 16; index += 1) {
    result[index] = Number(remaining & BigInt(255));
    remaining >>= BigInt(8);
  }
  return result;
}

function ownerFromProvider(): anchor.web3.Keypair {
  return owner;
}

function readKpJson(keypairPath: string): anchor.web3.Keypair {
  const file = fs.readFileSync(keypairPath);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}

async function initAllocateCompDef(
  program: Program<Tender>,
  payer: anchor.web3.Keypair
): Promise<void> {
  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("allocate");
  const compDefPda = PublicKey.findProgramAddressSync(
    [baseSeed, program.programId.toBuffer(), offset],
    getArciumProgramId()
  )[0];
  const arciumProgram = getArciumProgram(provider);
  const mxeAccount = getMXEAccAddress(program.programId);
  const mxe = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(
    program.programId,
    mxe.lutOffsetSlot
  );
  const existing = await arciumProgram.account.computationDefinitionAccount
    .fetchNullable(compDefPda);
  if (!existing) {
    await program.methods
      .initAllocateCompDef()
      .accounts({
        compDefAccount: compDefPda,
        payer: payer.publicKey,
        mxeAccount,
        addressLookupTable: lutAddress,
      })
      .signers([payer])
      .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });
  }
  const rawCircuit = fs.readFileSync("build/allocate.arcis");
  await uploadCircuit(provider, "allocate", program.programId, rawCircuit, true);
}

async function getMXEPublicKeyWithRetry(
  testProvider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const publicKey = await getMXEPublicKey(testProvider, programId);
      if (publicKey) return publicKey;
    } catch (error) {
      console.log("MXE public key attempt " + attempt + " failed", error);
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error("Failed to fetch MXE public key");
}
