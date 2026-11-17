# Deployment

This page covers where the page, the API and the bucket live, and what each setup needs: one origin for the page and
the API, or an API on another origin, with cookies, `trustedOrigins` and the bucket's CORS rule. It also covers a TLS
proxy in front of the server, building without secrets, and Cloudflare Workers.

## Three places, two kinds of request

An **origin** is a scheme, host and port, such as `https://app.example.com`. An upload involves three:

| Where | What it is | Example |
| --- | --- | --- |
| The page | Where the browser runs your app and `cloudrop/client` | `https://app.example.com` |
| The API | Where `cloudrop.handler` is mounted (`basePath`) | `https://app.example.com/api/cloudrop` |
| The bucket | The storage endpoint the presigned URLs point at | `https://<account>.r2.cloudflarestorage.com` |

The browser makes two kinds of request:

- **Page to API:** `POST` to `/upload`, `/sign`, `/complete` and `/abort`, with cookies (`credentials: "include"`).
  The API decides from them who may upload.
- **Page to bucket:** `PUT` of the bytes to presigned URLs, with no cookies. The bucket's CORS rule decides whether the
  browser may send them.

So the bucket's CORS rule always lists the **page's** origin, never the API's: the bytes leave from the page. The
rule itself: [Bucket setup](bucket-setup.md).

## Same origin: the simple setup

When the page and the API share an origin, nothing needs configuring: the client's default `basePath`
(`/api/cloudrop`) reaches the handler, the browser sends the session cookie as a first-party cookie, and the handler
accepts requests from its own origin without `trustedOrigins`.

You get one origin in either of two ways:

- **One app serves both**, such as a Next.js app with the handler in `app/api/cloudrop/[...all]/route.ts`.
- **A proxy or rewrite** sends `/api/cloudrop/*` on the page's origin to a separate API server. In Next.js:

  ```ts
  // next.config.ts
  import type { NextConfig } from "next";

  const config: NextConfig = {
    async rewrites() {
      return [{ source: "/api/cloudrop/:path*", destination: "https://api.internal.example.com/api/cloudrop/:path*" }];
    },
  };

  export default config;
  ```

  The browser still sees one origin, but the API server now sees its own host in the request URL, not the page's. The
  handler compares the page's `Origin` header with the origin it sees, so list the page's public origin on the API
  server: `trustedOrigins: ["https://app.example.com"]`. The handler's log names both origins the first time it
  refuses one.

## Cross-origin: an API on another origin

The page at `https://app.example.com` calls an API at `https://api.example.com`.

On the client, set an absolute `basePath`:

```ts
const client = createCloudropClient<typeof cloudrop>({ basePath: "https://api.example.com/api/cloudrop" });
```

On the server, trust the page's origin. `basePath` stays the path on the API server:

```ts
export const cloudrop = createCloudrop({
  storage: r2(),
  trustedOrigins: ["https://app.example.com"], // exact origins, never "*"
  routes: { avatar },
});
```

The handler answers the browser's CORS preflight for those origins and allows credentials, and the client already sends
cookies. What remains is the cookie itself:

- **Same site, different origin.** `app.example.com` and `api.example.com` share the site `example.com`, so the browser
  sends cookies set for the API's host, or for `Domain=example.com`, even with `SameSite=Lax`. Ports do not change the
  site either: `http://localhost:3000` and `http://localhost:4000` are different origins of one site.
- **Different sites.** For a page on `app.example.com` and an API on `api.example.net`, the session cookie must be
  `SameSite=None; Secure`, and so served over HTTPS. Browsers that block third-party cookies may still drop it. If
  you cannot put the page and the API on one site, send a token instead:
  [Send a bearer token](client.md#send-a-bearer-token).

With `authorize` that finds no session, every upload ends `UNAUTHORIZED`: check in the browser's DevTools whether the
`/upload` request carried the cookie.

## Behind a proxy that terminates TLS

The handler takes its own origin from the request URL and trusts no `X-Forwarded-*` header. Behind a load balancer or
reverse proxy that terminates TLS or rewrites `Host`, the server sees `http://internal-host:3000` while the page is on
`https://app.example.com`, so your own pages look cross-origin and get `ORIGIN_NOT_ALLOWED`. List the public origin:

```ts
createCloudrop({
  // ...
  trustedOrigins: ["https://app.example.com"],
});
```

More: [Origins](server.md#origins) and [Troubleshooting](troubleshooting.md#every-request-gets-origin_not_allowed).

## Build without secrets

Settings that come from the environment, `CLOUDROP_SECRET` and the storage presets' variables, are read on the first
request, not when the module loads. So `next build`, or a Docker build stage without secrets, loads your server module
without any of them. Pass the secrets to the running server only.

A setting still missing at run time makes every upload request answer `500 SERVER_ERROR`, and the server logs one line
starting `cloudrop: every request answers 500 until this is fixed.` Once you set the missing values, the next request
picks them up, with no restart. A health check catches the problem at deploy time: any `cloudrop.api` call returns that
`INVALID_CONFIG` error. With `NODE_ENV=development`, the settings are checked when the server is created, so `next dev`
fails at start instead.

## Cloudflare Workers

- Call `cloudrop.handler(request)` from the Worker's `fetch` (see
  [Any runtime with Request and Response](server.md#any-runtime-with-request-and-response)).
- The library reads the environment only through `process.env`. Unless your Worker exposes it, pass `secret` and the
  storage credentials to `createCloudrop` and `r2()` explicitly (see
  [Settings from the environment](server.md#settings-from-the-environment)).
- How the server's parallel storage calls fit Workers' subrequest limits has not been measured yet.
