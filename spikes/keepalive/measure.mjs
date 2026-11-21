// Measures the browser's cap on keepalive request bodies in flight (decision M11-R87): how many of the /abort requests
// a page sends at once with `keepalive: true` the browser refuses, by body size. Run from the repository root:
//
//   node spikes/keepalive/measure.mjs
//
// It needs Playwright's Chromium headless shell, which examples/next installs
// (`bunx playwright install --only-shell chromium` in examples/next). The server listens on 127.0.0.1 only.

import { createServer } from "node:http";
import { createRequire } from "node:module";

const PORT = Number(process.env.CLOUDROP_KEEPALIVE_PORT ?? 19671);
const { chromium } = createRequire(new URL("../../examples/next/package.json", import.meta.url))("@playwright/test");

/** Answers each POST 300 ms after its body arrived, so every request of one round is in flight together. */
const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>keepalive</title>");
    return;
  }
  request.resume();
  request.on("end", () => setTimeout(() => response.writeHead(200).end("{}"), 300));
});

/**
 * In the page: sends `count` POSTs of `bytes` bytes at once and reports which failed. `keepalive: "budget"` sends as
 * the client does from M11-R87 on: with keepalive while 56 KiB of bodies are not passed, the rest without.
 */
async function round({ count, bytes, keepalive }) {
  const body = JSON.stringify({ token: "t".repeat(bytes - 12) });
  const kept = (index) => (keepalive === "budget" ? (index + 1) * body.length <= 56 * 1024 : keepalive);
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      // The answer is read to its end, as the client reads it: a body left unread keeps its request counted.
      fetch("/abort", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: kept(index),
      }).then(
        (response) => response.text().then(() => response.ok),
        () => false,
      ),
    ),
  );
  const firstRefused = results.indexOf(false);
  return {
    bodyBytes: new TextEncoder().encode(body).length,
    sent: count,
    refused: results.filter((passed) => !passed).length,
    // The bytes already in flight when the first request was refused.
    acceptedBytesBeforeFirstRefusal: firstRefused === -1 ? null : firstRefused * body.length,
  };
}

const ROUNDS = [
  { count: 230, bytes: 285, keepalive: true },
  { count: 230, bytes: 285, keepalive: false },
  { count: 230, bytes: 285, keepalive: "budget" },
  { count: 500, bytes: 420, keepalive: "budget" },
  { count: 160, bytes: 420, keepalive: true },
  { count: 500, bytes: 420, keepalive: true },
  { count: 10, bytes: 12_288, keepalive: true },
  { count: 1, bytes: 65_535, keepalive: true },
  { count: 1, bytes: 65_536, keepalive: true },
  { count: 1, bytes: 65_537, keepalive: true },
  { count: 2, bytes: 32_768, keepalive: true },
  // After the rounds above have been answered: the cap counts only what is in flight.
  { count: 100, bytes: 420, keepalive: true },
];

await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/`);
  console.log(`Chromium ${browser.version()}`);
  // A request the network failed is no finding about keepalive: on a machine where interfaces come and go (Docker),
  // Chromium fails requests in flight with net::ERR_NETWORK_CHANGED. A refusal for the cap never reaches the network,
  // so it shows here as no event at all. Run again when `networkFailures` is not empty.
  const networkFailures = [];
  page.on("requestfailed", (request) => networkFailures.push(request.failure()?.errorText));
  for (const input of ROUNDS) {
    networkFailures.length = 0;
    const result = await page.evaluate(round, input);
    console.log(JSON.stringify({ keepalive: input.keepalive, ...result, networkFailures: [...new Set(networkFailures)] }));
  }
} finally {
  await browser.close();
  server.close();
}
