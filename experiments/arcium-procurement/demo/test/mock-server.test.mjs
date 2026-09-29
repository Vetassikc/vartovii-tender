import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { createMockServer } from "../mock-server.mjs";

const marker = "MOCK ONLY · SYNTHETIC";
let server;
let baseUrl;
let temporaryRoot;
let staticRoot;

before(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "l1-mock-review-test-"));
  staticRoot = path.join(temporaryRoot, "dist");
  fs.mkdirSync(path.join(staticRoot, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(staticRoot, "index.html"),
    '<!doctype html><html><head><script type="module" src="/assets/app.js"></script></head><body><div id="app"></div></body></html>'
  );
  fs.writeFileSync(path.join(staticRoot, "assets", "app.js"), "document.body.dataset.loaded = 'true';\n");
  fs.writeFileSync(path.join(temporaryRoot, "outside.txt"), "outside the static root\n");
  fs.symlinkSync(path.join(temporaryRoot, "outside.txt"), path.join(staticRoot, "assets", "outside.txt"));

  server = createMockServer({ staticRoot });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test("binds only to IPv4 loopback and serves the buyer app with provenance before result content", async () => {
  assert.equal(server.address().address, "127.0.0.1");

  const response = await fetch(`${baseUrl}/buyer?tender=finalized-success-85`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.ok(html.indexOf(marker) >= 0);
  assert.ok(html.indexOf(marker) < html.indexOf('<div id="app">'));
  assert.match(html, /assets\/app\.js/);
});

test("serves existing static client assets without modifying their bytes", async () => {
  const response = await fetch(`${baseUrl}/assets/app.js`);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "document.body.dataset.loaded = 'true';\n");
});

test("does not follow a static asset symlink outside the built client", async () => {
  const response = await fetch(`${baseUrl}/assets/outside.txt`);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid static asset path." });
});

test("returns the four named synthetic read fixtures with fail-closed awards", async (t) => {
  const cases = [
    {
      name: "finalized-success-85",
      status: 200,
      state: "finalized",
      resultStatus: 0,
      verification: "verified-finalized-program-state",
      award: { lot0Supplier: 2, lot1Supplier: 0, lot0Price: 45, lot1Price: 40, total: 85 },
    },
    {
      name: "pending",
      status: 200,
      state: "queued",
      resultStatus: null,
      verification: "unverified",
      award: null,
    },
    {
      name: "finalized-nonzero-no-award",
      status: 200,
      state: "finalized",
      resultStatus: 1,
      verification: "unverified",
      award: null,
    },
    {
      name: "account-read-failure",
      status: 503,
      error: "Synthetic account read failure; no account data is available.",
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const response = await fetch(`${baseUrl}/api/tenders/${fixture.name}`);
      const payload = await response.json();

      assert.equal(response.status, fixture.status);
      assert.equal(response.headers.get("x-mock-mode"), "MOCK ONLY; SYNTHETIC");
      if (fixture.error) {
        assert.deepEqual(payload, { error: fixture.error });
        return;
      }
      assert.equal(payload.fixture, true);
      assert.equal(payload.tender, fixture.name);
      assert.equal(payload.state, fixture.state);
      assert.equal(payload.resultStatus, fixture.resultStatus);
      assert.equal(payload.verification, fixture.verification);
      assert.deepEqual(payload.award, fixture.award);
    });
  }
});

test("returns explicit mock mode without live RPC or wallet configuration", async () => {
  const response = await fetch(`${baseUrl}/api/config`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ready, true);
  assert.equal(payload.mock, true);
  assert.equal(payload.status, "mock");
  assert.equal(payload.provenance, marker);
  assert.equal("rpcUrl" in payload, false);
  assert.equal("mxePublicKey" in payload, false);
});

test("fails closed for every non-GET method and non-allowlisted API route", async (t) => {
  const rejectedRequests = [
    ["POST", "/api/config"],
    ["POST", "/api/tenders/finalized-success-85"],
    ["POST", "/api/tenders/finalized-success-85/freeze"],
    ["DELETE", "/api/tenders/finalized-success-85"],
  ];

  for (const [method, route] of rejectedRequests) {
    await t.test(`${method} ${route}`, async () => {
      const response = await fetch(`${baseUrl}${route}`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET");
      assert.deepEqual(await response.json(), { error: "Mock review server supports GET only." });
    });
  }

  for (const route of [
    "/api/unknown",
    "/api/tenders/not-a-fixture",
    "/api/tenders/constructor",
    "/api/tenders/__proto__",
    "/api/tenders/toString",
  ]) {
    await t.test(`GET ${route}`, async () => {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Unknown mock review route." });
    });
  }
});
