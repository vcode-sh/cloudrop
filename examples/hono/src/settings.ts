// The server's and the worker's settings, read from the environment once by their composition roots. An app with its
// own env schema reads them through it; this typed reader keeps the example free of such a dependency. Bun loads
// .env first (scripts/setup-rustfs.ts writes it). cloudrop reads its own settings, CLOUDROP_SECRET and the storage
// preset's CLOUDROP_S3_* or CLOUDROP_R2_* variables, on its first request.

export interface Settings {
  /** The API's port: 5181. */
  port: number;
  /** The API's public origin, better-auth's `baseURL`: http://localhost:5181. */
  apiOrigin: string;
  /** The web app's origin, the only one CORS, better-auth and cloudrop trust: http://localhost:5173. */
  webOrigin: string;
  databaseUrl: string;
  /** better-auth's signing secret, 32 characters or more. */
  authSecret: string;
  /** Bytes each user may keep, from UPLOAD_QUOTA_MB (1 MB = 1024 * 1024 bytes, as cloudrop counts sizes). */
  quotaBytes: number;
  /** How often the worker sweeps abandoned uploads, from SWEEP_INTERVAL_MINUTES. */
  sweepIntervalMs: number;
  /** Which cloudrop preset reads the storage settings: s3 when CLOUDROP_S3_ENDPOINT is set and not empty, else r2. */
  storage: "s3" | "r2";
}

type Environment = Record<string, string | undefined>;

export function readSettings(env: Environment): Settings {
  const missing = ["DATABASE_URL", "BETTER_AUTH_SECRET"].filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Set ${missing.join(" and ")}: bun run setup:rustfs writes them to .env. Then start again.`);
  }
  const authSecret = env.BETTER_AUTH_SECRET ?? "";
  if (authSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET is shorter than 32 characters. Make one with: openssl rand -base64 32");
  }
  const port = wholeNumber(env, "PORT", 5181);
  return {
    port,
    apiOrigin: origin(env, "API_ORIGIN", `http://localhost:${port}`),
    webOrigin: origin(env, "WEB_ORIGIN", "http://localhost:5173"),
    databaseUrl: env.DATABASE_URL ?? "",
    authSecret,
    quotaBytes: wholeNumber(env, "UPLOAD_QUOTA_MB", 500) * 1024 * 1024,
    sweepIntervalMs: wholeNumber(env, "SWEEP_INTERVAL_MINUTES", 60) * 60_000,
    storage: env.CLOUDROP_S3_ENDPOINT ? "s3" : "r2",
  };
}

function wholeNumber(env: Environment, name: string, fallback: number): number {
  const value = env[name];
  if (!value) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a whole number above 0, such as ${fallback}; it is "${value}".`);
  }
  return number;
}

/** An exact origin, as CORS compares it: scheme, host and port, no path or trailing slash. */
function origin(env: Environment, name: string, fallback: string): string {
  const value = env[name] || fallback;
  if (!URL.canParse(value) || new URL(value).origin !== value) {
    throw new Error(
      `${name} must be an origin such as ${fallback}, without a path or a trailing slash; it is "${value}".`,
    );
  }
  return value;
}
