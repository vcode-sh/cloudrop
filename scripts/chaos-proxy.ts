// Starts the chaos proxy in front of an S3 endpoint for the browser lane: `node scripts/chaos-proxy.ts <target>`.
// scripts/test-browser.sh runs it after RustFS is up, reads the one line it prints once both ports listen, and stops it
// with a signal. The proxy listens on CLOUDROP_CHAOS_PROXY_PORT (default 19110); its control endpoint, which the
// Playwright tests call, takes a free loopback port and is the line's last word.
import { startChaosProxy } from "../packages/cloudrop/src/testing/chaos-proxy.ts";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/chaos-proxy.ts <target URL>, for example http://127.0.0.1:19100");
  process.exit(2);
}
const port = Number(process.env.CLOUDROP_CHAOS_PROXY_PORT ?? 19110);
const proxy = await startChaosProxy(target, { port, control: true });
console.log(`Chaos proxy on ${proxy.url} in front of ${target}; control on ${proxy.controlUrl}`);
