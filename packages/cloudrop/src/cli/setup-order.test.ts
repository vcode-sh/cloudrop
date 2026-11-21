import { describe, expect, it } from "vitest";
import { bucket, ORIGIN, run } from "./command-fixture.ts";

// R2 answers a request with the first CORS rule that matches all of it, never a later one (measured 2026-11-21:
// r2-spike-findings.md, "Which CORS rule answers when several match"). The fake answers the same way, so each case
// ends with what a browser on the origin gets from the bucket setup left behind.
const LOCAL = "http://localhost:5173";
const cors = (...rules: string[]) => ({ cors: `<CORSConfiguration>${rules.join("")}</CORSConfiguration>` });
const rule = (id: string, origin: string, rest: string) =>
  `<CORSRule>${id && `<ID>${id}</ID>`}<AllowedOrigin>${origin}</AllowedOrigin>${rest}</CORSRule>`;
const ANY_HEADER =
  "<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedHeader>*</AllowedHeader>";
const EXPOSED = "<ExposeHeader>ETag</ExposeHeader><ExposeHeader>Retry-After</ExposeHeader>";
const OURS = `<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>content-type</AllowedHeader><AllowedHeader>content-disposition</AllowedHeader><AllowedHeader>if-none-match</AllowedHeader><AllowedHeader>x-amz-meta-cloudrop-id</AllowedHeader>${EXPOSED}<MaxAgeSeconds>3600</MaxAgeSeconds>`;

const setup = (...extra: string[]) => ["setup", "--origin", ORIGIN, ...extra];
const ids = async (storage: ReturnType<typeof bucket>) => (await storage.cors())?.map((each) => each.id ?? null);
const WORKS = { preflight: 204, put: 200, exposed: "ETag,Retry-After" };
const WHY = (name: string, origins = ORIGIN) =>
  ` The storage service answers a request with the first rule that matches it, and ${name} matches uploads from ${origins} without exposing Retry-After.`;

describe("cloudrop setup --apply and the order of CORS rules", () => {
  it("places its rule before an earlier rule for any origin that exposes no Retry-After, and a second run changes nothing", async () => {
    const storage = bucket(cors(rule("legacy", "*", ANY_HEADER)));
    expect(await storage.upload(ORIGIN)).toEqual({ preflight: 204, put: 200, exposed: null });
    const dryRun = await run(setup("--dry-run"), { fetch: storage.fetch });
    expect(dryRun.lines[1]).toBe(
      `dry run      CORS: would add rule "cloudrop-uploads" for ${ORIGIN} before rule "legacy" and keep 1 other rule ("legacy").${WHY('rule "legacy"')}`,
    );
    const applied = await run(setup("--apply"), { fetch: storage.fetch });
    expect(applied.lines[1]).toBe(
      `ok           CORS: added rule "cloudrop-uploads" for ${ORIGIN} before rule "legacy" and kept 1 other rule ("legacy").${WHY('rule "legacy"')}`,
    );
    expect(await ids(storage)).toEqual(["cloudrop-uploads", "legacy"]);
    expect(await storage.upload(ORIGIN)).toEqual(WORKS);
    const doctor = await run(["doctor", "--origin", ORIGIN], { fetch: storage.fetch });
    expect(doctor.lines).toContain(`ok           CORS: Browsers on ${ORIGIN} can upload and read Retry-After.`);
    const again = await run(setup("--apply"), { fetch: storage.fetch });
    expect([again.lines[1], storage.writes.filter((write) => write === "PUT ?cors=")]).toEqual([
      `ok           CORS: rule "cloudrop-uploads" already allows uploads from ${ORIGIN} as cloudrop's rule does; nothing to change.`,
      ["PUT ?cors="],
    ]);
  });

  it("moves its own rule, once, when it stands after a rule that answers in its place", async () => {
    const storage = bucket(
      cors(
        rule("reads", "*", "<AllowedMethod>GET</AllowedMethod>"),
        rule("", "*", ANY_HEADER),
        rule("cloudrop-uploads", ORIGIN, OURS),
      ),
    );
    const applied = await run(setup("--apply"), { fetch: storage.fetch });
    expect(applied.lines[1]).toBe(
      `ok           CORS: moved rule "cloudrop-uploads" before rule 2 (no ID) and kept 2 other rules ("reads", a rule without an ID).${WHY("rule 2 (no ID)")}`,
    );
    // Only cloudrop's rule moved: the others keep their order, and the one that answered no upload stays first.
    expect(await ids(storage)).toEqual(["reads", "cloudrop-uploads", null]);
    expect(await storage.upload(ORIGIN)).toEqual(WORKS);
    await run(setup("--apply"), { fetch: storage.fetch });
    expect(storage.writes.filter((write) => write === "PUT ?cors=")).toEqual(["PUT ?cors="]);
  });

  it("adds an origin to its rule and moves it in one write when only the new origin is answered by another rule", async () => {
    const storage = bucket(cors(rule("local", LOCAL, ANY_HEADER), rule("cloudrop-uploads", ORIGIN, OURS)));
    const applied = await run(["setup", "--origin", ORIGIN, "--origin", LOCAL, "--apply"], { fetch: storage.fetch });
    expect(applied.lines[1]).toBe(
      `ok           CORS: added origins ${LOCAL} to rule "cloudrop-uploads", moved it before rule "local" and kept 1 other rule ("local").${WHY('rule "local"', LOCAL)}`,
    );
    expect(await ids(storage)).toEqual(["cloudrop-uploads", "local"]);
    expect([await storage.upload(ORIGIN), await storage.upload(LOCAL)]).toEqual([WORKS, WORKS]);
  });

  it("appends its rule after a rule for another origin, which answers none of its requests", async () => {
    const storage = bucket(cors(rule("staging", "https://staging.example.com", ANY_HEADER)));
    const applied = await run(setup("--apply"), { fetch: storage.fetch });
    expect(applied.lines[1]).toBe(
      `ok           CORS: added rule "cloudrop-uploads" for ${ORIGIN} and kept 1 other rule ("staging").`,
    );
    expect(await ids(storage)).toEqual(["staging", "cloudrop-uploads"]);
    expect(await storage.upload(ORIGIN)).toEqual(WORKS);
  });

  it("adds nothing when an earlier rule already answers every request as cloudrop's rule would", async () => {
    const complete = rule("everything", "*", `${ANY_HEADER}<AllowedMethod>HEAD</AllowedMethod>${EXPOSED}`);
    const storage = bucket(cors(complete));
    const applied = await run(setup("--apply"), { fetch: storage.fetch });
    expect([applied.lines[1], storage.writes.includes("PUT ?cors=")]).toEqual([
      `ok           CORS: rule "everything" already allows uploads from ${ORIGIN} as cloudrop's rule does; nothing to change.`,
      false,
    ]);
    expect(await storage.upload(ORIGIN)).toEqual(WORKS);
  });

  // The rule answers uploads in full but no HEAD, which cloudrop's rule allows: the rule is still added, after it.
  it("adds its rule after a rule that answers uploads in full but not every method cloudrop's rule allows", async () => {
    const storage = bucket(cors(rule("uploads-only", "*", `${ANY_HEADER}${EXPOSED}`)));
    await run(setup("--apply"), { fetch: storage.fetch });
    expect(await ids(storage)).toEqual(["uploads-only", "cloudrop-uploads"]);
  });
});

describe("cloudrop setup and a bucket that holds several rules with cloudrop's ID (M11-R204)", () => {
  const twice = () => bucket(cors(rule("cloudrop-uploads", ORIGIN, OURS), rule("cloudrop-uploads", LOCAL, OURS)));
  const origins = async (storage: ReturnType<typeof bucket>) =>
    (await storage.cors())?.map((each) => each.allowedOrigins);

  it("says that it merged them into one, in a dry run and when it writes", async () => {
    const storage = twice();
    const dryRun = await run(setup("--dry-run"), { fetch: storage.fetch });
    expect(dryRun.lines[1]).toBe(
      'dry run      CORS: would merge the 2 rules named "cloudrop-uploads" into one, which allows everything they allow.',
    );
    const applied = await run(setup("--apply"), { fetch: storage.fetch });
    expect(applied.lines[1]).toBe(
      'ok           CORS: merged the 2 rules named "cloudrop-uploads" into one, which allows everything they allowed.',
    );
    expect(await origins(storage)).toEqual([[ORIGIN, LOCAL]]);
  });

  it("names the merge beside what it adds and where the rule moves", async () => {
    const storage = bucket(
      cors(
        rule("legacy", "*", ANY_HEADER),
        rule("cloudrop-uploads", ORIGIN, OURS),
        rule("cloudrop-uploads", LOCAL, OURS),
      ),
    );
    const staging = "https://staging.example.com";
    const applied = await run(["setup", "--origin", staging, "--apply"], { fetch: storage.fetch });
    expect(applied.lines[1]).toBe(
      `ok           CORS: merged the 2 rules named "cloudrop-uploads" into one, which allows everything they allowed, added origins ${staging} to it, moved it before rule "legacy" and kept 1 other rule ("legacy").${WHY('rule "legacy"', staging)}`,
    );
    expect(await origins(storage)).toEqual([[ORIGIN, LOCAL, staging], ["*"]]);
  });
});

describe("cloudrop doctor and the order of CORS rules", () => {
  // Uploads work, so the finding is ok; what setup --apply would change follows as advice.
  it("names the rule that answers in place of cloudrop's, and the command that fixes it", async () => {
    const storage = bucket(cors(rule("", "*", ANY_HEADER), rule("cloudrop-uploads", ORIGIN, OURS)));
    const result = await run(["doctor", "--origin", ORIGIN], { fetch: storage.fetch });
    expect(result.lines).toContain(
      `ok           CORS: Browsers on ${ORIGIN} can upload. Rule 1 (no ID) answers uploads from ${ORIGIN} and does not expose Retry-After, so after a 429 or 503 a page cannot wait as long as the bucket asks. It stands before rule "cloudrop-uploads", which exposes it: the storage service answers a request with the first rule that matches it, never a later one. Add Retry-After to its exposed headers, or put a rule that exposes it before it. Run: npx cloudrop setup --origin ${ORIGIN} --apply`,
    );
  });

  // 0.5.0 wrote ETag and Retry-After into its rule; a rule that exposes Retry-After alone serves a page as well.
  it("finds nothing to say about a rule that exposes Retry-After and no ETag", async () => {
    const withoutEtag = OURS.replace("<ExposeHeader>ETag</ExposeHeader>", "");
    const storage = bucket(cors(rule("mine", ORIGIN, withoutEtag)));
    const result = await run(["doctor", "--origin", ORIGIN], { fetch: storage.fetch });
    expect(result.lines).toContain(`ok           CORS: Browsers on ${ORIGIN} can upload and read Retry-After.`);
    const applied = await run(setup("--apply"), { fetch: storage.fetch });
    expect(applied.lines[1]).toBe(
      `ok           CORS: rule "mine" already allows uploads from ${ORIGIN} as cloudrop's rule does; nothing to change.`,
    );
  });
});

describe("cloudrop setup without --apply and the order of CORS rules", () => {
  it("says where its rule goes among the rules the reader keeps", async () => {
    const result = await run(["setup", "--origin", ORIGIN, "--origin", LOCAL]);
    expect(result.lines).toContain(
      `Where the CORS rule goes: the storage service answers a request with the first rule that matches it, never a later one. Put cloudrop's rule before any rule you keep that also allows PUT from ${ORIGIN}, ${LOCAL}, such as a rule for every origin ("*").`,
    );
  });
});
