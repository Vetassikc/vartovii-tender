import assert from "node:assert/strict";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const demoRoot = path.resolve(testDirectory, "..");
const repositoryRoot = path.resolve(demoRoot, "../../..");
const testOutputRoot = path.join(repositoryRoot, ".runtime/arcium-spike/b3-buyer-submit-correction");
let vite;
let buyerClient;
let originalDocument;
let originalWindow;

before(async () => {
  originalDocument = globalThis.document;
  originalWindow = globalThis.window;
  globalThis.document = {
    querySelector(selector) {
      return selector === "#app" ? { innerHTML: "" } : null;
    },
  };
  globalThis.window = { location: { pathname: "/", port: "4173" } };

  vite = await createServer({
    root: demoRoot,
    configFile: path.join(demoRoot, "vite.config.mjs"),
    cacheDir: path.join(testOutputRoot, "vite-cache"),
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  buyerClient = await vite.ssrLoadModule("/src/client.js");
});

after(async () => {
  await vite?.close();
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test("buyer submit stays visibly pending and sends no POST before config is ready", async () => {
  let resolveConfig;
  const harness = createHarness({
    loadConfig: () => new Promise((resolve) => { resolveConfig = resolve; }),
    createTender: async () => ({ tender: "unused" }),
  });

  assert.equal(harness.submitButton.disabled, true);
  assert.equal(harness.statusElement.hidden, false);
  assert.match(harness.statusElement.textContent, /checking local runtime/i);
  await harness.submit();
  assert.equal(harness.posts.length, 0);

  resolveConfig({ ready: true });
  await harness.initialization;
  assert.equal(harness.submitButton.disabled, false);
});

test("rapid ready-state submits issue one POST and apply one tender result", async () => {
  let resolvePost;
  const harness = createHarness({
    loadConfig: async () => ({ ready: true }),
    createTender: () => {
      return new Promise((resolve) => { resolvePost = resolve; });
    },
  });
  await harness.initialization;

  const first = harness.submit();
  const second = harness.submit();
  assert.deepEqual(harness.posts, [{ path: "/api/tenders", method: "POST" }]);
  assert.equal(harness.submitButton.disabled, true);
  assert.equal(harness.statusElement.hidden, false);
  assert.match(harness.statusElement.className, /warning/);
  assert.match(harness.statusElement.textContent, /creating local tender/i);
  resolvePost({ tender: "local-tender-001" });
  await Promise.all([first, second]);

  assert.equal(harness.createdCount, 1);
  assert.equal(harness.url, "/buyer?tender=local-tender-001");
  assert.equal(harness.receipt, "Tender local-tender-001");
});

test("an unready local runtime keeps creation disabled and shows a local-only status", async () => {
  const harness = createHarness({
    loadConfig: async () => ({ ready: false, status: "pending" }),
    createTender: async () => ({ tender: "unused" }),
  });
  await harness.initialization;
  await harness.submit();

  assert.equal(harness.submitButton.disabled, true);
  assert.equal(harness.posts.length, 0);
  assert.equal(harness.statusElement.hidden, false);
  assert.match(harness.statusElement.className, /warning|error/);
  assert.match(harness.statusElement.textContent, /remains disabled/i);
  assert.equal(harness.url, "/buyer");
  assert.equal(harness.receipt, "No tender yet.");
});

test("a config failure is visible and cannot create a false tender receipt or URL", async () => {
  const harness = createHarness({
    loadConfig: async () => { throw new Error("mock config unavailable"); },
    createTender: async () => ({ tender: "unused" }),
  });
  await harness.initialization;
  await harness.submit();

  assert.equal(harness.submitButton.disabled, true);
  assert.equal(harness.posts.length, 0);
  assert.equal(harness.statusElement.hidden, false);
  assert.match(harness.statusElement.className, /error/);
  assert.match(harness.statusElement.textContent, /could not be verified/i);
  assert.equal(harness.url, "/buyer");
  assert.equal(harness.receipt, "No tender yet.");
});

test("a tender POST failure is visible without a false tender receipt or URL", async () => {
  const harness = createHarness({
    loadConfig: async () => ({ ready: true }),
    createTender: async () => { throw new Error("mock POST unavailable"); },
  });
  await harness.initialization;
  await harness.submit();

  assert.equal(harness.createdCount, 0);
  assert.equal(harness.url, "/buyer");
  assert.equal(harness.receipt, "No tender yet.");
  assert.equal(harness.statusElement.hidden, false);
  assert.match(harness.statusElement.className, /error/);
  assert.match(harness.statusElement.textContent, /outcome is unconfirmed/i);
  assert.match(harness.statusElement.textContent, /mock POST unavailable/);
  assert.equal(harness.submitButton.disabled, true);
  await harness.submit();
  assert.deepEqual(harness.posts, [{ path: "/api/tenders", method: "POST" }]);
});

function createHarness({ loadConfig, createTender }) {
  assert.equal(typeof buyerClient?.initializeBuyerSubmit, "function");
  let submitHandler;
  const submitButton = { disabled: false };
  const statusElement = { hidden: true, className: "notice", textContent: "" };
  const harness = {
    url: "/buyer",
    receipt: "No tender yet.",
    createdCount: 0,
    posts: [],
    submitButton,
    statusElement,
    submit() {
      return submitHandler({ preventDefault() {} });
    },
  };
  const form = {
    addEventListener(type, handler) {
      if (type === "submit") submitHandler = handler;
    },
  };

  function request(path, options = {}) {
    if (path === "/api/config") return loadConfig();
    if (path === "/api/tenders") {
      harness.posts.push({ path, method: options.method || "GET" });
      return createTender(options.body);
    }
    throw new Error(`Unexpected mock API route: ${path}`);
  }

  harness.initialization = buyerClient.initializeBuyerSubmit({
    form,
    submitButton,
    statusElement,
    request,
    getInvitedSuppliers: () => ["supplier-a", "supplier-b", "supplier-c"],
    onTenderCreated(result) {
      harness.createdCount += 1;
      harness.url = `/buyer?tender=${encodeURIComponent(result.tender)}`;
      harness.receipt = `Tender ${result.tender}`;
    },
  });
  return harness;
}
