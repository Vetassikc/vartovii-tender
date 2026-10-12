import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 4174;
const PROVENANCE = "MOCK ONLY · SYNTHETIC";
const PROVENANCE_HEADER = "MOCK ONLY; SYNTHETIC";
const DEMO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_ROOT = path.join(DEMO_ROOT, "dist");
const FIXTURES = Object.freeze({
  "finalized-success-85": Object.freeze({
    fixture: true,
    tender: "finalized-success-85",
    tenderId: "85000000000000000000000000000000",
    deadline: 4102444800,
    state: "finalized",
    stateLabel: "Finalized · synthetic",
    bidCount: 3,
    commitment: "11".repeat(32),
    resultStatus: 0,
    verification: "verified-finalized-program-state",
    timestamps: Object.freeze({ readAt: "2026-09-29T12:00:00.000Z" }),
    award: Object.freeze({
      lot0Supplier: 2,
      lot1Supplier: 0,
      lot0Price: 45,
      lot1Price: 40,
      total: 85,
    }),
  }),
  pending: Object.freeze({
    fixture: true,
    tender: "pending",
    tenderId: "22000000000000000000000000000000",
    deadline: 4102444800,
    state: "queued",
    stateLabel: "Queued · pending",
    bidCount: 3,
    commitment: "22".repeat(32),
    resultStatus: null,
    verification: "unverified",
    timestamps: Object.freeze({ readAt: "2026-09-29T12:00:00.000Z" }),
    award: null,
  }),
  "finalized-nonzero-no-award": Object.freeze({
    fixture: true,
    tender: "finalized-nonzero-no-award",
    tenderId: "33000000000000000000000000000000",
    deadline: 4102444800,
    state: "finalized",
    stateLabel: "Finalized · no award",
    bidCount: 3,
    commitment: "33".repeat(32),
    resultStatus: 1,
    verification: "unverified",
    timestamps: Object.freeze({ readAt: "2026-09-29T12:00:00.000Z" }),
    award: null,
  }),
});

const ACCOUNT_READ_FAILURE = "Synthetic account read failure; no account data is available.";
const MOCK_CONFIG = Object.freeze({
  ready: true,
  status: "mock",
  mock: true,
  provenance: PROVENANCE,
});

export function createMockServer({ staticRoot = DEFAULT_STATIC_ROOT } = {}) {
  const resolvedStaticRoot = path.resolve(staticRoot);
  return http.createServer((request, response) => {
    applyResponseHeaders(response);
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: "Mock review server accepts loopback clients only." });
      return;
    }

    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      sendJson(response, 405, { error: "Mock review server supports GET only." });
      return;
    }

    let url;
    try {
      url = new URL(request.url ?? "/", `http://${HOST}`);
    } catch {
      sendJson(response, 400, { error: "Invalid mock review request URL." });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      handleApi(url, response);
      return;
    }
    serveStatic(url.pathname, resolvedStaticRoot, response);
  });
}

export function startMockServer({ port = configuredPort() } = {}) {
  const server = createMockServer();
  server.listen(port, HOST, () => {
    process.stdout.write(`${PROVENANCE} buyer review at http://${HOST}:${server.address().port}/buyer?tender=finalized-success-85\n`);
  });
  return server;
}

function handleApi(url, response) {
  if (url.pathname === "/api/config") {
    sendJson(response, 200, MOCK_CONFIG);
    return;
  }

  const tenderMatch = url.pathname.match(/^\/api\/tenders\/([^/]+)$/);
  if (!tenderMatch) {
    sendJson(response, 404, { error: "Unknown mock review route." });
    return;
  }

  let fixtureName;
  try {
    fixtureName = decodeURIComponent(tenderMatch[1]);
  } catch {
    sendJson(response, 400, { error: "Invalid mock fixture name." });
    return;
  }

  if (fixtureName === "account-read-failure") {
    sendJson(response, 503, { error: ACCOUNT_READ_FAILURE });
    return;
  }

  if (!Object.hasOwn(FIXTURES, fixtureName)) {
    sendJson(response, 404, { error: "Unknown mock review route." });
    return;
  }
  sendJson(response, 200, FIXTURES[fixtureName]);
}

function serveStatic(requestPath, staticRoot, response) {
  let realStaticRoot;
  try {
    realStaticRoot = fs.realpathSync(staticRoot);
  } catch {
    sendJson(response, 503, { error: "Built mock client is missing." });
    return;
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    sendJson(response, 400, { error: "Invalid static asset path." });
    return;
  }

  if (decodedPath.includes("\0")) {
    sendJson(response, 400, { error: "Invalid static asset path." });
    return;
  }

  const requestedPath = decodedPath === "/" || decodedPath === "/buyer" || decodedPath === "/supplier"
    ? "/index.html"
    : decodedPath;
  const filePath = path.resolve(realStaticRoot, `.${requestedPath}`);
  if (filePath !== realStaticRoot && !filePath.startsWith(`${realStaticRoot}${path.sep}`)) {
    sendJson(response, 400, { error: "Invalid static asset path." });
    return;
  }

  let realFilePath;
  let stat;
  try {
    realFilePath = fs.realpathSync(filePath);
    if (realFilePath !== realStaticRoot && !realFilePath.startsWith(`${realStaticRoot}${path.sep}`)) {
      sendJson(response, 400, { error: "Invalid static asset path." });
      return;
    }
    stat = fs.statSync(realFilePath);
  } catch {
    sendJson(response, 404, { error: "Mock client asset not found." });
    return;
  }
  if (!stat.isFile()) {
    sendJson(response, 404, { error: "Mock client asset not found." });
    return;
  }

  const extension = path.extname(filePath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  }[extension] ?? "application/octet-stream";
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");

  if (extension === ".html") {
    let html;
    try {
      html = fs.readFileSync(realFilePath, "utf8");
    } catch {
      sendJson(response, 500, { error: "Mock client page could not be read." });
      return;
    }
    const banner = `<aside id="l1-mock-provenance" role="note" aria-label="Mock data provenance" style="display:flex;flex-wrap:wrap;gap:0.4rem 1rem;align-items:center;padding:0.8rem 1rem;background:#ffe3a3;color:#211b0f;border-bottom:3px solid #9b6416;font:600 14px/1.4 system-ui,sans-serif"><strong>${PROVENANCE}</strong><span>Loopback-only read fixtures. No live adapter, RPC, wallet, or account data.</span></aside>`;
    if (html.includes('id="l1-mock-provenance"')) {
      response.writeHead(200);
      response.end(html);
      return;
    }
    const markedHtml = html.replace(/<body\b[^>]*>/i, (bodyTag) => `${bodyTag}${banner}`);
    if (markedHtml === html) {
      sendJson(response, 503, { error: "Built mock client page is missing its body element." });
      return;
    }
    response.writeHead(200);
    response.end(markedHtml);
    return;
  }

  response.writeHead(200);
  fs.createReadStream(realFilePath).pipe(response);
}

function applyResponseHeaders(response) {
  response.setHeader("X-Mock-Mode", PROVENANCE_HEADER);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function configuredPort() {
  const value = process.env.L1_MOCK_PORT;
  if (value === undefined || value === "") return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("L1_MOCK_PORT must be an integer between 0 and 65535.");
  }
  return port;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) startMockServer();
