import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createDemoServer } from "../server.mjs";

test("server binds role pages and mutations to fixed local origins", async () => {
  const server = createDemoServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const wrongBuyerPage = await request(port, "/buyer", { headers: { Host: `supplier-a.localhost:${port}` } });
    assert.equal(wrongBuyerPage.status, 421);

    const supplierPage = await request(port, "/supplier?slot=0", { headers: { Host: `supplier-a.localhost:${port}` } });
    assert.equal(supplierPage.status, 200);

    const wrongSupplierPage = await request(port, "/supplier?slot=0", { headers: { Host: `supplier-b.localhost:${port}` } });
    assert.equal(wrongSupplierPage.status, 421);

    const wrongMutationRole = await request(port, "/api/tenders", {
      method: "POST",
      headers: { Host: `supplier-a.localhost:${port}`, Origin: `http://supplier-a.localhost:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ invited: [] }),
    });
    assert.equal(wrongMutationRole.status, 421);

    const wrongOrigin = await request(port, "/api/supplier-provision", {
      method: "POST",
      headers: { Host: `supplier-a.localhost:${port}`, Origin: `http://supplier-b.localhost:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ slot: 0, supplier: "11111111111111111111111111111111" }),
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongContentType = await request(port, "/api/tenders", {
      method: "POST",
      headers: { Host: `buyer.localhost:${port}`, Origin: `http://buyer.localhost:${port}`, "Content-Type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongContentType.status, 415);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function request(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path, ...options }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}
