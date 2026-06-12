"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const assert = require("node:assert/strict");
const { extractEntries } = require("./import-requests");
const { inspectOne } = require("./inspect");

const brotliCompress = promisify(zlib.brotliCompress);

async function runSelfTest() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "ikea-assets-test-"));
  const agentBrowserJson = JSON.stringify({
    success: true,
    data: {
      requests: [
        {
          url: "https://d1rnl1hhzmmov0.cloudfront.net/catalog.default_agg.br",
          method: "GET",
          mimeType: "application/octet-stream",
          status: 200,
          resourceType: "Fetch",
        },
      ],
    },
  });
  const entries = extractEntries(agentBrowserJson, "network.json");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url.includes("catalog.default_agg.br"), true);

  const brPath = path.join(temp, "sample.br");
  await fs.writeFile(brPath, await brotliCompress(Buffer.from(JSON.stringify({ hello: "planner" }))));
  const result = await inspectOne(brPath, { out: temp, writeDecoded: true });
  assert.equal(result.kind, "brotli");
  assert.equal(result.decodedKind, "json");
  assert.ok(result.decodedPath);

  console.log("self-test ok");
}

module.exports = { runSelfTest };
