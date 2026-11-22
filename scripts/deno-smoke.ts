// The Deno smoke test (M12-P5): the packed package, installed as a project's node_modules/cloudrop, uploads one file
// on Deno through `cloudrop.handler`, on cloudrop/testing's in-process bucket. scripts/check-deno.sh copies this file
// into a project beside the unpacked tarball and runs it; it throws, so Deno exits 1, at the first answer that is not the
// expected one. Deno resolves `npm:` through the fixture's node_modules (deno.json: nodeModulesDir "manual"), so no
// registry is asked, and grants env access only to the variables cloudrop reads (NODE_ENV and CLOUDROP_*): without it
// r2() throws Deno's NotCapable. Not compiled by the workspace's tsc: `npm:` is Deno's own.
import { allowAnyone, createCloudrop, route } from "npm:cloudrop";
import { testBucket } from "npm:cloudrop/testing";

const ORIGIN = "http://localhost";
const bucket = testBucket();
const cloudrop = createCloudrop({
  storage: bucket.storage,
  secret: "deno-smoke-secret-of-at-least-32-characters",
  routes: { notes: route({ accept: "text/plain", maxSize: "1KB", authorize: allowAnyone }) },
});

function post(endpoint: string, body: unknown): Promise<Response> {
  return cloudrop.handler(
    new Request(`${ORIGIN}/api/cloudrop/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    }),
  );
}

function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(`Deno smoke test: ${what}`);
}

// The resume guide says Deno has no IndexedDB, so a client there keeps nothing for resuming: measured here.
expect(
  typeof indexedDB === "undefined",
  "this Deno has an indexedDB global, so the resume guide's claim that Deno has none is wrong: change the guide",
);

const bytes = new TextEncoder().encode("hello");
const upload = await post("upload", {
  route: "notes",
  files: [{ name: "a.txt", size: bytes.length, type: "text/plain" }],
});
const answer = await upload.json();
expect(upload.status === 200, `/upload answered ${upload.status}: ${JSON.stringify(answer)}`);
expect(answer.files?.length === 1 && answer.files[0].kind === "single", `/upload answered ${JSON.stringify(answer)}`);
const [ticket] = answer.files;

const put = await bucket.fetch(ticket.put.url, { method: "PUT", headers: ticket.put.headers, body: bytes });
expect(put.ok, `the bucket answered the PUT with ${put.status}`);

const complete = await post("complete", { token: ticket.token });
const completed = await complete.json();
expect(
  complete.status === 200 && completed.file?.key === ticket.key,
  `/complete answered ${JSON.stringify(completed)}`,
);
expect(bucket.object(ticket.key)?.size === bytes.length, "the bucket does not hold the uploaded file");
console.log(`${navigator.userAgent}: no indexedDB; /upload answered one ticket, and /complete stored ${ticket.key}.`);
