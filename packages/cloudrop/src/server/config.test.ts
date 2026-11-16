import { afterEach, describe, expect, it, vi } from "vitest";
import { r2 } from "../storage/presets.ts";
import { type CloudropOptions, readConfig } from "./config.ts";
import { allowAnyone, type Route, route } from "./route.ts";
import { importTokenKey, signToken, verifyToken } from "./token.ts";

const storage = r2({
  bucket: "uploads",
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "k",
  secretAccessKey: "s",
});
const publicStorage = r2({
  bucket: "uploads",
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "k",
  secretAccessKey: "s",
  publicUrl: "https://cdn.example.com",
});
const files = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone });

const SECRET = "test-secret-0123456789abcdef0123456789";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** readConfig, as createCloudrop calls it, with sound defaults and one override, called the way plain JavaScript may call it. */
function create(overrides: Record<string, unknown>) {
  return () =>
    readConfig({ storage, secret: SECRET, routes: { files }, ...overrides } as CloudropOptions<Record<string, Route>>);
}

function invalidRoute(options: Record<string, unknown>) {
  return create({
    routes: { avatar: { definition: { accept: "*/*", maxSize: "1MB", authorize: allowAnyone, ...options } } },
  });
}

describe("readConfig errors", () => {
  it.for<{ name: string; make: () => unknown; message: string }>([
    {
      name: "no options",
      make: () => (readConfig as (options?: unknown) => unknown)(),
      message: "Pass storage to createCloudrop: r2({ bucket }) or s3({ ... }).",
    },
    // The route checks read rules.maxObjectSize; without it they would throw a TypeError.
    {
      name: "a storage without rules",
      make: create({ storage: { presignPut: () => {} } }),
      message: "Pass storage to createCloudrop: r2({ bucket }) or s3({ ... }).",
    },
    {
      name: "no routes",
      make: create({ routes: {} }),
      message: "Pass at least one route: routes: { avatar: route({ ... }) }.",
    },
    {
      name: "routes of null",
      make: create({ routes: null }),
      message: "Pass at least one route: routes: { avatar: route({ ... }) }.",
    },
    // A list would pass as routes named "0", "1"…
    {
      name: "routes as a list",
      make: create({ routes: [files] }),
      message: "Pass at least one route: routes: { avatar: route({ ... }) }.",
    },
    {
      name: "a route name with a slash",
      make: create({ routes: { "a/b": files } }),
      message: 'Route name "a/b" may use only letters, digits, - and _ (at most 64), such as avatar or post-image.',
    },
    {
      name: "a route not made by route()",
      make: create({ routes: { avatar: { accept: "*/*" } } }),
      message: 'Route "avatar" is not a route. Wrap its options in route({ ... }).',
    },
    {
      name: "a route of null",
      make: create({ routes: { avatar: null } }),
      message: 'Route "avatar" is not a route. Wrap its options in route({ ... }).',
    },
    {
      name: "a route without authorize",
      make: invalidRoute({ authorize: undefined }),
      message: 'Route "avatar" needs authorize. Use authorize: allowAnyone for a route anyone may upload to.',
    },
    {
      name: "an empty accept list",
      make: invalidRoute({ accept: [] }),
      message: 'Route "avatar": accept takes MIME types in lower case, such as "image/png", "image/*" or "*/*".',
    },
    {
      name: "an extension in accept",
      make: invalidRoute({ accept: ".png" }),
      message: 'Route "avatar": accept takes MIME types in lower case, such as "image/png", "image/*" or "*/*".',
    },
    {
      name: "a maxSize of 0",
      make: invalidRoute({ maxSize: 0 }),
      message: 'Route "avatar": maxSize must be between 1 byte and 5115 GiB, such as 5242880 or "5MB".',
    },
    {
      name: "a maxSize past R2's object limit",
      make: invalidRoute({ maxSize: "5TB" }),
      message: 'Route "avatar": maxSize must be between 1 byte and 5115 GiB, such as 5242880 or "5MB".',
    },
    {
      name: "a maxSize with a space",
      make: invalidRoute({ maxSize: "5 MB" }),
      message: 'Route "avatar": maxSize must be between 1 byte and 5115 GiB, such as 5242880 or "5MB".',
    },
    {
      name: "maxFiles of 101",
      make: invalidRoute({ maxFiles: 101 }),
      message: 'Route "avatar": maxFiles must be a whole number from 1 to 100.',
    },
    {
      name: "a metadata value that is no schema",
      make: invalidRoute({ metadata: { albumId: "string" } }),
      message: 'Route "avatar": metadata must be a Standard Schema, such as a zod, valibot or arktype schema.',
    },
    {
      name: "a metadata schema of null",
      make: invalidRoute({ metadata: null }),
      message: 'Route "avatar": metadata must be a Standard Schema, such as a zod, valibot or arktype schema.',
    },
    {
      name: "a prefix that is a string",
      make: invalidRoute({ prefix: "avatars" }),
      message: 'Route "avatar": prefix must be a function.',
    },
    {
      name: "both prefix and key",
      make: invalidRoute({ prefix: () => "a", key: () => "b" }),
      message: 'Route "avatar": pass prefix or key, not both. key builds the whole key; prefix only its folder.',
    },
    {
      name: "a visibility in other words",
      make: invalidRoute({ visibility: "hidden" }),
      message: 'Route "avatar": visibility must be "public" or "private".',
    },
    {
      name: "a public route without publicUrl",
      make: invalidRoute({ visibility: "public" }),
      message:
        'Route "avatar" is public, but the storage has no publicUrl. Pass publicUrl to the storage preset, or make the route private.',
    },
    {
      name: "a basePath with a trailing slash",
      make: create({ basePath: "/api/cloudrop/" }),
      message: 'basePath must be a path such as "/api/cloudrop": a leading slash, no trailing slash, no query.',
    },
    // The URL parser resolves "/api/.." away, so a handler mounted there would never match a request.
    {
      name: "a basePath with a .. segment",
      make: create({ basePath: "/api/.." }),
      message: 'basePath must be a path such as "/api/cloudrop": a leading slash, no trailing slash, no query.',
    },
    // "*" would hand every site a credentialed CORS answer.
    {
      name: 'a trusted origin of "*"',
      make: create({ trustedOrigins: ["*"] }),
      message:
        'trustedOrigins must list exact origins such as "https://app.example.com": scheme and host, no path or trailing slash, and never "*".',
    },
    {
      name: "a trusted origin with a trailing slash",
      make: create({ trustedOrigins: ["https://app.example.com/"] }),
      message:
        'trustedOrigins must list exact origins such as "https://app.example.com": scheme and host, no path or trailing slash, and never "*".',
    },
    {
      name: "a multipartThreshold in words",
      make: create({ multipartThreshold: "big" }),
      message: 'multipartThreshold must be a whole number of bytes or a size such as "64MB".',
    },
    {
      name: "plugins that are not a list",
      make: create({ plugins: { id: "a" } }),
      message: "plugins must be a list, such as plugins: [limits()].",
    },
    {
      name: "two plugins with one id",
      make: create({ plugins: [{ id: "a" }, { id: "a" }] }),
      message: "Every plugin needs its own id. Pass each plugin once.",
    },
    // The handler would call it on the first upload and answer 500.
    {
      name: "a plugin hook that is not a function",
      make: create({ plugins: [{ id: "limits", server: { beforeUpload: "reserve" } }] }),
      message: 'Plugin "limits": server takes only functions for beforeUpload, afterVerify, onAbort and extendRoute.',
    },
    // The handler reports every failure through the logger; without warn or error it would throw instead.
    {
      name: "a logger without warn",
      make: create({ logger: { error: () => {} } }),
      message: "logger needs error(message, error) and warn(message) methods, such as console or a pino logger.",
    },
    {
      name: "a 31-character secret",
      make: create({ secret: "s".repeat(31) }),
      message:
        "Each upload token secret must be text of at least 32 characters. Generate one with `openssl rand -base64 32`.",
    },
    {
      name: "a short previous secret",
      make: create({ secret: [SECRET, "short"] }),
      message:
        "Each upload token secret must be text of at least 32 characters. Generate one with `openssl rand -base64 32`.",
    },
    {
      name: "an empty secret list",
      make: create({ secret: [] }),
      message:
        "Missing the upload token secret. Set CLOUDROP_SECRET or pass secret to createCloudrop(); generate one with `openssl rand -base64 32`.",
    },
  ])("throws INVALID_CONFIG for $name", ({ make, message }) => {
    expect(make).toThrow(expect.objectContaining({ code: "INVALID_CONFIG", message }));
  });

  it("accepts a 32-character secret", () => {
    expect(create({ secret: "s".repeat(32) })).not.toThrow();
  });

  // createCloudrop throws only INVALID_CONFIG: a plugin's own error is kept as the cause.
  it("lets a plugin refuse a route it cannot serve", () => {
    const refusal = new Error("images() cannot serve route files");
    const plugin = {
      id: "images",
      server: {
        extendRoute: () => {
          throw refusal;
        },
      },
    };
    expect(create({ plugins: [plugin] })).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          'Plugin "images": extendRoute failed for route "files". Its cause says why; fix the plugin or the route.',
        cause: refusal,
      }),
    );
  });

  // Plugins and the logger see a configuration only once every check has passed.
  it("checks the secret before it warns or calls extendRoute", () => {
    const events: string[] = [];
    const logger = { error: () => {}, warn: () => void events.push("warn") };
    const plugin = { id: "spy", server: { extendRoute: () => void events.push("extendRoute") } };
    const privateFiles = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone, visibility: "private" });
    const make = () =>
      readConfig({ storage: publicStorage, secret: "short", routes: { privateFiles }, plugins: [plugin], logger });
    expect(make).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
    expect(events).toEqual([]);
  });
});

describe("readConfig defaults", () => {
  const payload = {
    v: 1,
    route: "files",
    fileId: "f",
    key: "k",
    name: "n",
    size: 1,
    type: "text/plain",
    owner: {},
    metadata: null,
    exp: 2,
  } as const;

  it("signs tokens with the secret from CLOUDROP_SECRET", async () => {
    vi.stubEnv("CLOUDROP_SECRET", SECRET);
    const { signing } = await readConfig({ storage, routes: { files } }).tokenKeys;
    const token = await signToken(payload, signing);
    expect((await verifyToken(token, [await importTokenKey(SECRET)], 1)).data).toEqual(payload);
  });

  it("refuses to start when CLOUDROP_SECRET is empty and no secret is passed", () => {
    vi.stubEnv("CLOUDROP_SECRET", "");
    expect(() => readConfig({ storage, routes: { files } })).toThrow(
      expect.objectContaining({
        code: "INVALID_CONFIG",
        message:
          "Missing the upload token secret. Set CLOUDROP_SECRET or pass secret to createCloudrop(); generate one with `openssl rand -base64 32`.",
      }),
    );
  });

  it("makes a route public when the storage has a publicUrl, and private otherwise", () => {
    expect([
      readConfig({ storage: publicStorage, secret: SECRET, routes: { files } }).routes.get("files")?.visibility,
      readConfig({ storage, secret: SECRET, routes: { files } }).routes.get("files")?.visibility,
    ]).toEqual(["public", "private"]);
  });

  it("warns when a private route stores files on a bucket with a public URL", () => {
    const warnings: string[] = [];
    const logger = { error: () => {}, warn: (message: string) => void warnings.push(message) };
    const privateFiles = route({ accept: "*/*", maxSize: "1MB", authorize: allowAnyone, visibility: "private" });
    readConfig({ storage: publicStorage, secret: SECRET, routes: { privateFiles }, logger });
    expect(warnings).toEqual([
      'cloudrop: route "privateFiles" is private, but the storage has a publicUrl, so anyone who learns a key can read the file. Serve private files from a bucket without a public domain.',
    ]);
  });
});
