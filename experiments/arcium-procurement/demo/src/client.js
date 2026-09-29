import nacl from "tweetnacl";
import { RescueCipher } from "@arcium-hq/client/src/cryptography/rescueCipher.ts";
import {
  Connection,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { createEncryptionIdentity, deriveRescueSharedSecret, requireTenderDto } from "./protocol.mjs";
import { actionCopy, buyerReadoutModel, isTrustedAward, tenderLifecycleRailModel } from "./tender-view.mjs";
import "./styles.css";

const app = document.querySelector("#app");

app.innerHTML = `
  <main class="shell">
    <p class="eyebrow">VARTOVII COMMIT / LOCAL PROOF SURFACE</p>
    <h1>Confidential procurement, made inspectable.</h1>
    <p class="lede">A bounded two-lot tender where suppliers submit encrypted quotes and the buyer receives only the finalized allocation.</p>
    <section class="notice" data-role="notice" hidden></section>
    <section class="role-picker" aria-label="Choose role">
      <a class="role-link" href="${roleUrl("buyer", "/buyer")}">Open buyer desk <span>→</span></a>
      <div class="supplier-links">
        <span>Supplier sessions</span>
        <a href="${roleUrl("supplier", "/supplier?slot=0", 0)}">A</a>
        <a href="${roleUrl("supplier", "/supplier?slot=1", 1)}">B</a>
        <a href="${roleUrl("supplier", "/supplier?slot=2", 2)}">C</a>
      </div>
    </section>
  </main>
`;

const notice = document.querySelector('[data-role="notice"]');
const path = window.location.pathname;
if (path === "/buyer") renderBuyer();
else if (path === "/supplier") renderSupplier();

function renderBuyer() {
  app.innerHTML = `
    <main class="shell wide">
      <header class="masthead">
        <div>
          <p class="eyebrow">BUYER DESK / CONFIDENTIAL PROCUREMENT</p>
          <h1>Assemble a tender. Read one bounded decision.</h1>
          <p class="lede">The buyer can verify the lifecycle and final allocation. Supplier quotes remain encrypted through submission and MPC execution.</p>
        </div>
        <a class="quiet-link" href="${roleUrl("buyer", "/")}">Exit desk</a>
      </header>
      <section class="notice" data-role="buyer-status" role="status" aria-live="polite" hidden></section>
      <section class="status-rail" data-role="status-rail" aria-label="Tender lifecycle"></section>
      <div class="workbench">
        <section class="panel primary-panel">
          <div class="panel-kicker">01 / TENDER SETUP</div>
          <div class="panel-heading"><h2>Invite three supplier sessions</h2><span class="role-chip buyer-chip">Buyer</span></div>
          <p class="panel-copy">Paste the public identity from each isolated supplier origin. Only public keys leave those sessions.</p>
          <form data-role="create-form" class="stack-form">
            <div class="supplier-grid">
              ${["A", "B", "C"].map((slot) => `<label>Supplier ${slot}<input required data-invited="${slot}" placeholder="Ed25519 public key" autocomplete="off" /></label>`).join("")}
            </div>
            <div class="lot-brief"><span>Lot 01</span><strong>Structured data review</strong><span>Lot 02</span><strong>Evidence quality pass</strong></div>
            <button class="button" type="submit" disabled>Create local tender <span>↗</span></button>
          </form>
          <div class="panel-actions" data-role="buyer-actions" hidden>
            <div class="action-row"><button class="button" data-action="freeze" disabled>Freeze complete set <span>↗</span></button><button class="button secondary" data-action="queue" disabled>Queue MPC allocation <span>↗</span></button></div>
            <p class="microcopy" data-role="action-copy">Waiting for three encrypted submissions.</p>
          </div>
        </section>
        <aside class="panel side-panel">
          <div class="panel-kicker">READOUT</div>
          <div data-role="buyer-readout"></div>
          <details class="evidence"><summary>View verification receipt</summary><pre data-role="receipt">No tender yet.</pre></details>
        </aside>
      </div>
      <section class="footer-note">Localnet only · synthetic identities · no settlement · one machine is not independent trust</section>
    </main>
  `;
  bootBuyer();
}

function renderSupplier() {
  const slot = new URLSearchParams(window.location.search).get("slot");
  const supplierSlot = Number(slot);
  const letter = ["A", "B", "C"][supplierSlot] || "A";
  app.innerHTML = `
    <main class="shell wide supplier-shell">
      <header class="masthead">
        <div>
          <p class="eyebrow">SUPPLIER SESSION ${letter} / ISOLATED ORIGIN</p>
          <h1>Submit a quote without handing over the quote.</h1>
          <p class="lede">This session encrypts your two prices and capacity in the browser. The buyer receives no losing quote.</p>
        </div>
        <a class="quiet-link" href="${roleUrl("supplier", "/", supplierSlot)}">Exit session</a>
      </header>
      <section class="notice" data-role="notice" hidden></section>
      <section class="privacy-strip"><strong>Private session</strong><span>Signing and encryption keys stay in this browser origin.</span><code>${window.location.host}</code></section>
      <div class="workbench supplier-workbench">
        <section class="panel primary-panel">
          <div class="panel-kicker">SUPPLIER ${letter} / IDENTITY</div>
          <div class="identity-block"><span class="identity-label">Public identity to share with buyer</span><code data-role="supplier-public">Generating…</code><button class="text-button" data-action="copy-public">Copy public key</button></div>
          <form data-role="bid-form" class="stack-form" hidden>
            <label>Tender address<input required data-field="tender" placeholder="Paste buyer tender address" autocomplete="off" /></label>
            <div class="supplier-grid two-cols"><label>Lot 01 price<input required data-field="lot0" type="number" min="0" max="1000000" step="1" /></label><label>Lot 02 price<input required data-field="lot1" type="number" min="0" max="1000000" step="1" /></label></div>
            <label>Declared capacity (1 or 2 lots)<input required data-field="capacity" type="number" min="1" max="2" step="1" /></label>
            <button class="button" type="submit">Encrypt and submit bid <span>↗</span></button>
          </form>
          <div class="session-state" data-role="supplier-state">Create or reconnect a tender as buyer, then paste its address here.</div>
        </section>
        <aside class="panel side-panel">
          <div class="panel-kicker">TRANSPORT CHECK</div>
          <div class="transport-checks"><div><span class="check-dot" data-check="plaintext">○</span><span>Plaintext stays client-side</span></div><div><span class="check-dot" data-check="ciphertext">○</span><span>Encrypted fields sent</span></div><div><span class="check-dot" data-check="signature">○</span><span>Ed25519 protocol message signed</span></div></div>
          <p class="microcopy">The loopback adapter relays an already-signed transaction. It does not receive this session's private keys.</p>
        </aside>
      </div>
    </main>
  `;
  bootSupplier(supplierSlot, letter);
}

export function initializeBuyerSubmit({
  form,
  submitButton,
  statusElement,
  request = api,
  getInvitedSuppliers,
  onTenderCreated,
  canCreate = true,
}) {
  let runtimeReady = false;
  let submitPending = false;
  let submissionUnconfirmed = false;

  submitButton.disabled = true;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canCreate || !runtimeReady || submitPending || submissionUnconfirmed) return;

    submitPending = true;
    submitButton.disabled = true;
    setBuyerStatus(statusElement, "warning", "Creating local tender…");
    try {
      const result = await request("/api/tenders", {
        method: "POST",
        body: {
          invited: getInvitedSuppliers(),
          deadline: Math.floor(Date.now() / 1000) + 900,
        },
      });
      if (typeof result?.tender !== "string" || !result.tender.trim()) {
        throw new Error("The local API did not confirm a tender address.");
      }
      await onTenderCreated(result);
      setBuyerStatus(statusElement, "success", "Local tender created.");
    } catch (error) {
      submissionUnconfirmed = true;
      setBuyerStatus(
        statusElement,
        "error",
        `Tender creation outcome is unconfirmed. Verify local state before another attempt. ${errorMessage(error)}`
      );
    } finally {
      submitPending = false;
      submitButton.disabled = !runtimeReady || !canCreate || submissionUnconfirmed;
    }
  });

  setBuyerStatus(statusElement, "warning", "Checking local runtime before enabling tender creation…");
  return Promise.resolve()
    .then(() => request("/api/config"))
    .then((config) => {
      if (!config?.ready) {
        setBuyerStatus(
          statusElement,
          "warning",
          `Local runtime is ${config?.status ?? "unavailable"}. Tender creation remains disabled. Check the approved local runtime, then reload this page.`
        );
        return { ready: false, config };
      }
      const mockMode = config.mock === true;
      runtimeReady = !mockMode;
      submitButton.disabled = !canCreate || !runtimeReady;
      setBuyerStatus(
        statusElement,
        mockMode || !canCreate ? "warning" : "success",
        mockMode
          ? "Mock fixture only. Local runtime and RPC are not connected."
          : canCreate
            ? "Local runtime ready. Tender creation is available."
            : "Local runtime ready. Loading the requested tender."
      );
      return { ready: true, config };
    })
    .catch((error) => {
      setBuyerStatus(
        statusElement,
        "error",
        `Local runtime status could not be verified: ${errorMessage(error)}. Tender creation remains disabled. Check the local runtime, then reload.`
      );
      return { ready: false, error };
    });
}

async function bootBuyer() {
  const state = { config: null, tender: null };
  const form = document.querySelector('[data-role="create-form"]');
  const submitButton = form.querySelector('button[type="submit"]');
  const statusElement = document.querySelector('[data-role="buyer-status"]');
  const actions = document.querySelector('[data-role="buyer-actions"]');
  const readout = document.querySelector('[data-role="buyer-readout"]');
  const receipt = document.querySelector('[data-role="receipt"]');
  const tenderFromUrl = new URLSearchParams(window.location.search).get("tender");
  if (tenderFromUrl) {
    form.hidden = true;
    actions.hidden = false;
    document.querySelector(".primary-panel .panel-kicker").textContent = "02 / TENDER ACTIONS";
    document.querySelector(".primary-panel .panel-heading h2").textContent = "Tender controls";
    document.querySelector(".primary-panel .panel-copy").textContent = "Continue this tender only when its current account state allows an action.";
  }
  bindStatusRail(null);
  const runtime = await initializeBuyerSubmit({
    form,
    submitButton,
    statusElement,
    canCreate: !tenderFromUrl,
    getInvitedSuppliers: () => ["A", "B", "C"].map((slot) => form.querySelector(`[data-invited="${slot}"]`).value.trim()),
    onTenderCreated: async (result) => {
      state.tender = result.tender;
      history.replaceState({}, "", `/buyer?tender=${encodeURIComponent(result.tender)}`);
      form.hidden = true;
      actions.hidden = false;
      await refreshBuyer(result.tender, state, readout, receipt);
    },
  });
  state.config = runtime.config ?? null;
  if (runtime.ready && tenderFromUrl) await refreshBuyer(tenderFromUrl, state, readout, receipt);
  document.querySelector('[data-action="freeze"]').addEventListener("click", async () => {
    await buyerAction("freeze", state, readout, receipt);
  });
  document.querySelector('[data-action="queue"]').addEventListener("click", async () => {
    await buyerAction("queue", state, readout, receipt);
  });
}

async function refreshBuyer(tender, state, readout, receipt) {
  try {
    const result = await api(`/api/tenders/${encodeURIComponent(tender)}`);
    state.tender = tender;
    renderBuyerReadout(result, readout, receipt);
    bindStatusRail(result);
    const freeze = document.querySelector('[data-action="freeze"]');
    const queue = document.querySelector('[data-action="queue"]');
    freeze.disabled = result.state !== "open" || result.bidCount !== 3;
    queue.disabled = result.state !== "frozen";
    document.querySelector('[data-role="action-copy"]').textContent = actionCopy(result);
  } catch (error) {
    renderUnavailable(readout, error, receipt, tender);
  }
}

async function buyerAction(action, state, readout, receipt) {
  const button = document.querySelector(`[data-action="${action}"]`);
  setBusy(button, true);
  try {
    const result = await api(`/api/tenders/${encodeURIComponent(state.tender)}/${action}`, { method: "POST" });
    renderBuyerReadout(result, readout, receipt);
    bindStatusRail(result);
    document.querySelector('[data-role="action-copy"]').textContent = actionCopy(result);
    const freeze = document.querySelector('[data-action="freeze"]');
    const queue = document.querySelector('[data-action="queue"]');
    freeze.disabled = result.state !== "open" || result.bidCount !== 3;
    queue.disabled = result.state !== "frozen";
  } catch (error) {
    renderUnavailable(readout, error, receipt, state.tender);
  } finally {
    setBusy(button, false);
  }
}

async function bootSupplier(slot, letter) {
  const identity = getSupplierIdentity(slot);
  document.querySelector('[data-role="supplier-public"]').textContent = identity.signing.publicKey;
  document.querySelector('[data-action="copy-public"]').addEventListener("click", async () => {
    await navigator.clipboard.writeText(identity.signing.publicKey);
    showNotice("Public key copied. Share only this value with the buyer.", "success");
  });
  document.querySelector('[data-role="bid-form"]').hidden = false;
  document.querySelector('[data-role="bid-form"]').addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(form, true);
    try {
      const config = await api("/api/config");
      const tender = await api(`/api/tenders/${encodeURIComponent(form.querySelector('[data-field="tender"]').value.trim())}`);
      const prices = [Number(form.querySelector('[data-field="lot0"]').value), Number(form.querySelector('[data-field="lot1"]').value)];
      const capacity = Number(form.querySelector('[data-field="capacity"]').value);
      const prepared = prepareBid(config, tender, slot, prices, capacity, identity);
      markCheck("plaintext");
      await api("/api/supplier-provision", { method: "POST", body: { tender: tender.tender, slot, supplier: identity.signing.publicKey } });
      const transaction = await buildSupplierTransaction(config, tender, slot, prepared, identity);
      markCheck("signature");
      const result = await api("/api/supplier-bid", { method: "POST", body: { tender: tender.tender, slot, rawTransaction: transaction } });
      markCheck("ciphertext");
      document.querySelector('[data-role="supplier-state"]').textContent = `Bid accepted for supplier ${letter}. Signature: ${result.signature}`;
      showNotice("Encrypted bid accepted by the local tender program.", "success");
      form.querySelectorAll("input[type=number]").forEach((input) => { input.disabled = true; });
    } catch (error) {
      showNotice(error.message, "error");
    } finally {
      setBusy(form, false);
    }
  });
}

function getSupplierIdentity(slot) {
  const key = `b3-supplier-${slot}`;
  const stored = sessionStorage.getItem(key);
  if (stored) return JSON.parse(stored);
  const signing = nacl.sign.keyPair();
  const encryption = createEncryptionIdentity();
  const identity = {
    signing: { publicKey: bytesToBase58(signing.publicKey), secretKey: bytesToBase64(signing.secretKey) },
    encryption: { publicKey: bytesToBase64(encryption.publicKey), secretKey: bytesToBase64(encryption.secretKey) },
  };
  sessionStorage.setItem(key, JSON.stringify(identity));
  return identity;
}

function prepareBid(config, tender, slot, prices, capacity, identity) {
  const tenderDto = requireTenderDto(tender);
  if (!prices.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000)) throw new Error("Prices must be whole numbers between 0 and 1,000,000.");
  if (![1, 2].includes(capacity)) throw new Error("Capacity must be 1 or 2.");
  const encryptionSecret = base64ToBytes(identity.encryption.secretKey);
  const encryptionPublicKey = base64ToBytes(identity.encryption.publicKey);
  const mxePublicKey = base64ToBytes(config.mxePublicKey);
  const sharedSecret = deriveRescueSharedSecret(encryptionSecret, mxePublicKey);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const ciphertexts = new RescueCipher(sharedSecret).encrypt(prices.map(BigInt).concat(BigInt(capacity)), nonceBytes).map((bytes) => Uint8Array.from(bytes));
  const nonce = littleEndianBigInt(nonceBytes);
  const message = bidMessage(config.programId, tenderDto.tenderId, slot, tenderDto.deadline, ciphertexts, encryptionPublicKey, nonce);
  const signing = JSON.parse(sessionStorage.getItem(`b3-supplier-${slot}`));
  const signature = nacl.sign.detached(message, base64ToBytes(signing.signing.secretKey));
  return { ciphertexts, encryptionPublicKey, nonce, signature, message };
}

async function buildSupplierTransaction(config, tender, slot, prepared, identity) {
  const connection = new Connection(config.rpcUrl, "confirmed");
  const supplier = nacl.sign.keyPair.fromSecretKey(base64ToBytes(identity.signing.secretKey));
  const supplierPublicKey = new PublicKey(base58ToBytes(identity.signing.publicKey));
  const ed25519 = Ed25519Program.createInstructionWithPublicKey({ publicKey: supplier.publicKey, message: prepared.message, signature: prepared.signature });
  const data = concatBytes([
    Uint8Array.from([19, 164, 237, 254, 64, 139, 237, 93]),
    hexToBytes(tender.tenderId),
    Uint8Array.from([slot]),
    ...prepared.ciphertexts,
    prepared.encryptionPublicKey,
    u128le(prepared.nonce),
    prepared.signature,
  ]);
  const instruction = new TransactionInstruction({ programId: new PublicKey(config.programId), keys: [
    { pubkey: new PublicKey(tender.tender), isSigner: false, isWritable: true },
    { pubkey: supplierPublicKey, isSigner: true, isWritable: false },
    { pubkey: new PublicKey("Sysvar1nstructions1111111111111111111111111"), isSigner: false, isWritable: false },
  ], data });
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ recentBlockhash: blockhash, feePayer: supplierPublicKey }).add(ed25519, instruction);
  transaction.partialSign({ publicKey: supplierPublicKey, secretKey: supplier.secretKey });
  return bytesToBase64(transaction.serialize());
}

function renderBuyerReadout(result, readout, receipt) {
  const model = buyerReadoutModel(result);
  const award = model.award;
  readout.innerHTML = `<div class="readout-state"><span class="state-dot ${stateClass(result)}"></span><span>${escapeHtml(result.stateLabel)}</span></div>
    <p class="readout-title">${escapeHtml(model.title)}</p>
    <div class="readout-facts"><div><span>Submitted bids</span><strong>${escapeHtml(model.bidCount ?? "Unavailable")}/3</strong></div>
      <div><span>Account read (UTC)</span><strong>${escapeHtml(formatAccountReadAt(model.accountReadAt))}</strong></div>
      <div class="readout-field"><span>Current tender</span><code>${escapeHtml(model.tender ?? "Unavailable")}</code></div>
      <div class="readout-field"><span>Commitment</span><code>${escapeHtml(model.commitment ?? "Not set")}</code></div></div>
    ${award ? `<div class="award"><span class="panel-kicker">BOUNDED AWARD / FINALIZED PROGRAM STATE</span><div class="award-line"><span>Lot 01</span><strong>Supplier ${String.fromCharCode(65 + award.lot0Supplier)}</strong><em>${award.lot0Price}</em></div><div class="award-line"><span>Lot 02</span><strong>Supplier ${String.fromCharCode(65 + award.lot1Supplier)}</strong><em>${award.lot1Price}</em></div><div class="award-total"><span>Total</span><strong>${award.total}</strong></div></div>` : `<div class="no-award">${escapeHtml(model.noAward)}</div>`}`;
  const awardReceipt = award
    ? `Lot 01: Supplier ${String.fromCharCode(65 + award.lot0Supplier)} at ${award.lot0Price}; Lot 02: Supplier ${String.fromCharCode(65 + award.lot1Supplier)} at ${award.lot1Price}; total ${award.total}.`
    : "No award is shown because this account state or result status is not trusted.";
  receipt.textContent = [
    `Tender account: ${model.tender ?? "Unavailable"}`,
    `Commitment: ${model.commitment ?? "Not set"}`,
    `Account state: ${model.accountState}; submitted bids: ${model.bidCount ?? "Unavailable"}/3.`,
    `Result status: ${model.resultStatus ?? "Unavailable or malformed"}.`,
    `Account read at: ${formatAccountReadAt(model.accountReadAt)}.`,
    `Account-state verification: ${model.accountVerification}`,
    `Award: ${awardReceipt}`,
    `Callback transaction provenance: ${model.callbackProvenance}`,
    `Verification limits: ${model.verificationLimit}`,
  ].join("\n");
}

function bindStatusRail(result) {
  const rail = document.querySelector('[data-role="status-rail"]');
  if (!rail) return;
  rail.innerHTML = tenderLifecycleRailModel(result).map(({ state, active, current }, index) =>
    '<div class="rail-step ' + (active ? "active" : "") + (current ? " current" : "") + '"><span>0' + (index + 1) + '</span><strong>' + state + '</strong></div>'
  ).join("");
}

function renderUnavailable(readout, error, receipt, tender) {
  bindStatusRail(null);
  document.querySelectorAll('[data-role="buyer-actions"] button').forEach((button) => { button.disabled = true; });
  document.querySelector('[data-role="action-copy"]').textContent = "Tender actions are disabled because the Tender account could not be read.";
  readout.innerHTML = `<div class="readout-state"><span class="state-dot unavailable"></span><span>Unavailable / pending</span></div><p class="readout-title">No award. The adapter could not establish a trusted finalized state.</p><p class="microcopy">${escapeHtml(error.message)}</p>`;
  receipt.textContent = [
    `Tender account: ${tender || "Unavailable"}`,
    "Commitment: unavailable because the Tender account could not be read.",
    "Account read: failed; no account-state verification is available.",
    "Award: none.",
    "This page does not independently recheck callback transaction history.",
  ].join("\n");
}

function formatAccountReadAt(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Not available";
  const formatted = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
  return `${formatted} UTC`;
}

function markCheck(name) {
  const element = document.querySelector(`[data-check="${name}"]`);
  element.textContent = "✓";
  element.classList.add("checked");
}

async function api(path, options = {}) {
  const response = await fetch(path, { method: options.method || "GET", headers: { "Content-Type": "application/json" }, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function setBusy(element, busy) {
  if (!element) return;
  element.classList.toggle("busy", busy);
  element.querySelectorAll("button, input").forEach((child) => { child.disabled = busy; });
}

function showNotice(message, kind) {
  const target = document.querySelector('[data-role="notice"]') || notice;
  if (!target) return;
  target.hidden = false;
  target.className = `notice ${kind}`;
  target.textContent = message;
}

function setBuyerStatus(element, kind, message) {
  if (!element) return;
  element.hidden = false;
  element.className = `notice ${kind}`;
  element.textContent = message;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "Unknown local error.";
}

function stateClass(result) { return isTrustedAward(result) ? "verified" : result.state === "unavailable" ? "unavailable" : "pending"; }
function littleEndianBigInt(bytes) { let value = 0n; for (let index = 0; index < bytes.length; index += 1) value |= BigInt(bytes[index]) << BigInt(index * 8); return value; }
function u128le(value) { const result = new Uint8Array(16); for (let index = 0; index < 16; index += 1) result[index] = Number((value >> BigInt(index * 8)) & 255n); return result; }
function i64le(value) { const result = new Uint8Array(8); new DataView(result.buffer).setBigInt64(0, BigInt(value), true); return result; }
function u32le(value) { const result = new Uint8Array(4); new DataView(result.buffer).setUint32(0, value, true); return result; }
function bidMessage(programId, tenderId, slot, deadline, ciphertexts, publicKey, nonce) { return concatBytes([base58ToBytes(programId), hexToBytes(tenderId), Uint8Array.from([slot]), i64le(deadline), u32le(1), u32le(1), ...ciphertexts, publicKey, u128le(nonce)]); }
function concatBytes(parts) { const total = parts.reduce((size, part) => size + part.length, 0); const result = new Uint8Array(total); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function bytesToBase64(bytes) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function base64ToBytes(value) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }
function bytesToBase58(bytes) { const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let value = 0n; for (const byte of bytes) value = (value << 8n) + BigInt(byte); let output = ""; while (value > 0n) { output = alphabet[Number(value % 58n)] + output; value /= 58n; } for (const byte of bytes) { if (byte !== 0) break; output = `1${output}`; } return output || "1"; }
function base58ToBytes(value) { const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let number = 0n; for (const character of value) { const index = alphabet.indexOf(character); if (index < 0) throw new Error("Invalid base58 public key"); number = number * 58n + BigInt(index); } const result = []; while (number > 0n) { result.unshift(Number(number & 255n)); number >>= 8n; } for (const character of value) { if (character !== "1") break; result.unshift(0); } return Uint8Array.from(result);
}
function hexToBytes(value) { if (!/^[0-9a-f]{32}$/i.test(value)) throw new Error("Tender id must be 16 bytes"); return Uint8Array.from(value.match(/.{2}/g).map((part) => parseInt(part, 16))); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character])); }

function roleUrl(role, path, slot) {
  const port = window.location.port || "4173";
  const host = role === "buyer" ? "buyer.localhost" : ["supplier-a.localhost", "supplier-b.localhost", "supplier-c.localhost"][slot ?? 0];
  return `http://${host}:${port}${path}`;
}
