# Security Policy

cloudrop signs URLs that let a browser write to your bucket. A bug here can mean someone else's files in your storage,
or yours overwritten, so security reports go to the front of the queue.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest 0.x release | Yes |
| Older releases | No |

Before 1.0, fixes land in the latest 0.x release only. Update to it first; the
[changelog](packages/cloudrop/CHANGELOG.md) says what changed.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request.** Email **hello@vcode.sh** with "cloudrop security" in the
subject. Include:

- **What** the vulnerability is, and which entry point (`cloudrop`, `cloudrop/client`, an adapter...) it is in.
- **How** to reproduce it: a minimal setup, the requests, the version, the runtime and the storage provider.
- **Impact:** what an attacker can do with it, and what they need first (a signed-in account, a leaked token, a
  position on the network).
- **A fix**, if you have one. Not required.

Leave out real credentials, presigned URLs and upload tokens; a redacted or expired one shows the shape just as well.

## What happens next

I maintain cloudrop alone, so these are times I can keep:

- **3 working days:** I acknowledge the report.
- **7 days:** I confirm whether it is a vulnerability and how severe it is, or tell you why not.
- **14 days:** a fix is released for a critical issue. Others get a fix or a documented workaround within 30 days.

If I go quiet past those times, send a follow-up email. Once a fix ships, the changelog and the release notes say what
was fixed, with credit to you, unless you prefer to stay anonymous.

## In scope

- **Upload tokens:** forging, tampering, replaying beyond their lifetime, or reading anything from them that should
  not be there. Tokens are signed with HMAC-SHA-256 and readable by design: what `authorize` returns is visible to the
  browser.
- **Presigning:** a URL that allows more than the one object, size, type and headers the server meant, outlives its
  15 minutes, or overwrites an existing object.
- **Authorization:** any path to an upload, a signed URL, a completion or a deletion that skips a route's `authorize`,
  a store's revocation or its quota, or that lets a client choose a key, size, type or upload ID the token did not
  carry.
- **Verification:** a stored object of the wrong size or type that `/complete` accepts.
- **Origins and CORS:** a cross-origin request the handler accepts without `trustedOrigins` listing that origin, or
  CORS headers that allow more than they should.
- **Leaks:** credentials, presigned URLs or raw storage responses in an error message, a client response or a log line
  cloudrop writes.
- **The browser client:** resume data or progress state that one origin, tab or user can use to act on another's
  upload.

## Out of scope

- Your bucket's own configuration (public access, a CORS rule that allows every origin) and the permissions of the
  storage token you give cloudrop. [Bucket setup](docs/guide/bucket-setup.md) gives the narrow ones.
- What your `authorize`, `onComplete` and storage callbacks do.
- The examples' demo sign-in, which exists to make them run without an identity provider.
- Denial of service through volume alone: rate limits belong in front of the handler.

## What is already in place

- **The server trusts only the upload token** after `/upload`. A key, size, type or upload ID in a request body is
  never used.
- **`authorize` is required** on every route, and runs before anything is signed.
- **Size and type are checked twice:** before signing, and again on the stored object at `/complete`.
- **The bucket enforces the plan:** a single-`PUT` URL signs the exact size, type and disposition, and
  `If-None-Match: *`, so it never overwrites an object; each multipart part URL signs that part's exact size. HTML, SVG
  and other non-media files are stored as `attachment`, so they never run as a page on a public bucket domain.
- **Secret rotation:** the server accepts several token secrets; the first signs and every one verifies.
- **Same-origin by default:** another origin may call the handler only when `trustedOrigins` names it exactly; `"*"` is
  refused.
- **Errors that leak nothing:** a client receives an error's code, message, `retryable` flag and part numbers only.
  Everything else goes to your logger, never with credentials or presigned URLs.
- **Zero runtime dependencies** and npm releases with provenance, built by a workflow that holds no npm token.
