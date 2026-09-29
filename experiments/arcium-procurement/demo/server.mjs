import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTender,
  TenderCreationFailure,
  freezeTender,
  getConfig,
  queueTender,
  readReceipt,
  readTender,
  relaySupplierBid,
  provisionSupplierFeePayer,
} from "./server/adapter.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.join(ROOT, "dist");
const HOST = "127.0.0.1";
const PORT = Number(process.env.B3_PORT ?? 4173);
const MAX_BODY_BYTES = 100_000;
const BUYER_HOST = "buyer.localhost";
const SUPPLIER_HOSTS = ["supplier-a.localhost", "supplier-b.localhost", "supplier-c.localhost"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function createDemoServer() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }
      serveStatic(url.pathname, url.searchParams, request, response);
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      sendJson(response, statusCode, apiErrorPayload(error));
    }
  });
}

export function startDemoServer() {
  const server = createDemoServer();
  server.listen(PORT, HOST, () => {
    process.stdout.write(`B3 demo listening on http://${HOST}:${PORT}\n`);
  });
  return server;
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    assertReadContext(request);
    sendJson(response, 200, await getConfig());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/tenders") {
    assertMutationContext(request, "buyer");
    sendJson(response, 201, await createTender(await readJson(request)));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/supplier-provision") {
    requireJsonContentType(request);
    const input = await readJson(request);
    assertMutationContext(request, "supplier", input.slot);
    sendJson(response, 200, await provisionSupplierFeePayer(input));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/supplier-bid") {
    requireJsonContentType(request);
    const input = await readJson(request);
    assertMutationContext(request, "supplier", input.slot);
    sendJson(response, 200, await relaySupplierBid(input));
    return;
  }
  const tenderMatch = url.pathname.match(/^\/api\/tenders\/([^/]+)$/);
  if (request.method === "GET" && tenderMatch) {
    assertReadContext(request);
    sendJson(response, 200, await readTender(decodeURIComponent(tenderMatch[1])));
    return;
  }
  const receiptMatch = url.pathname.match(/^\/api\/tenders\/([^/]+)\/receipt$/);
  if (request.method === "GET" && receiptMatch) {
    assertReadContext(request);
    sendJson(response, 200, await readReceipt(decodeURIComponent(receiptMatch[1])));
    return;
  }
  const actionMatch = url.pathname.match(/^\/api\/tenders\/([^/]+)\/(freeze|queue)$/);
  if (request.method === "POST" && actionMatch) {
    assertMutationContext(request, "buyer");
    const tender = decodeURIComponent(actionMatch[1]);
    const result = actionMatch[2] === "freeze" ? await freezeTender(tender) : await queueTender(tender);
    sendJson(response, 200, result);
    return;
  }
  sendJson(response, 404, { error: "Unknown local demo route." });
}

function serveStatic(requestPath, searchParams, request, response) {
  assertPageContext(request, requestPath, searchParams);
  if (!fs.existsSync(STATIC_ROOT)) {
    const error = new Error("Demo build is missing. Run the pinned Vite build first.");
    error.statusCode = 503;
    throw error;
  }
  const requested = requestPath === "/" || requestPath === "/buyer" || requestPath === "/supplier"
    ? "/index.html"
    : requestPath;
  const filePath = path.resolve(STATIC_ROOT, `.${requested}`);
  if (!filePath.startsWith(`${STATIC_ROOT}${path.sep}`)) {
    const error = new Error("Invalid static path.");
    error.statusCode = 400;
    throw error;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(response, 404, { error: "Demo asset not found." });
    return;
  }
  const extension = path.extname(filePath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  }[extension] ?? "application/octet-stream";
  response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
  fs.createReadStream(filePath).pipe(response);
}

async function readJson(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be JSON.");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

export function apiErrorPayload(error) {
  const payload = { error: safeMessage(error) };
  if (error instanceof TenderCreationFailure) payload.stage = error.stage;
  return payload;
}

function assertPageContext(request, requestPath, searchParams) {
  const host = baseHost(request.headers.host);
  if (requestPath === "/buyer") {
    assertRoleHost(host, "buyer");
    return;
  }
  if (requestPath === "/supplier") {
    assertRoleHost(host, "supplier", parseSlot(searchParams.get("slot")));
    return;
  }
  assertReadContext(request);
}

function assertReadContext(request) {
  const host = baseHost(request.headers.host);
  if (!LOOPBACK_HOSTS.has(host) && host !== BUYER_HOST && !SUPPLIER_HOSTS.includes(host)) {
    throw requestError(421, "Host is outside the local role surface.");
  }
}

function assertMutationContext(request, role, slot) {
  requireJsonContentType(request);
  const host = baseHost(request.headers.host);
  const expectedHost = role === "buyer" ? BUYER_HOST : SUPPLIER_HOSTS[parseSlot(slot)];
  if (host !== expectedHost && !LOOPBACK_HOSTS.has(host)) {
    throw requestError(421, "Mutation host does not match the local role.");
  }
  const origin = request.headers.origin;
  if (LOOPBACK_HOSTS.has(host)) {
    if (origin && !origin.startsWith("http://127.0.0.1:") && !origin.startsWith("http://localhost:")) {
      throw requestError(403, "Loopback mutation origin is not allowed.");
    }
    return;
  }
  const port = requestPort(request);
  const expectedOrigin = `http://${expectedHost}:${port}`;
  if (origin !== expectedOrigin) throw requestError(403, "Mutation origin does not match the local role.");
}

function assertRoleHost(host, role, slot) {
  const expected = role === "buyer" ? BUYER_HOST : SUPPLIER_HOSTS[slot];
  if (host !== expected) throw requestError(421, "Page host does not match the local role.");
}

function requireJsonContentType(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) {
    throw requestError(415, "Mutations require application/json.");
  }
}

function requestPort(request) {
  const host = String(request.headers.host ?? "");
  const port = host.includes(":") ? host.slice(host.lastIndexOf(":") + 1) : String(PORT);
  return /^\d+$/.test(port) ? port : String(PORT);
}

function baseHost(value) {
  const host = String(value ?? "").toLowerCase();
  return host.includes(":") ? host.slice(0, host.lastIndexOf(":")) : host;
}

function parseSlot(value) {
  const slot = Number(value);
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) throw requestError(400, "Supplier slot must be 0, 1, or 2.");
  return slot;
}

function requestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDemoServer();
}
