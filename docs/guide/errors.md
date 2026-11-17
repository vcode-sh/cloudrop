# Errors

This page lists every error code cloudrop produces: where it comes from, whether trying again can help, what it means,
and what your app or your user should do. It also explains the shape of an error and how errors move from the storage
service through your server to the browser.

## The shape of an error

Every public call returns `{ data, error }` instead of throwing for an expected failure. `error` is a `CloudropError`:

| Field | What it holds |
| --- | --- |
| `code` | A stable code from the tables below. Branch on this. |
| `message` | One or two sentences for a person: what happened and what to do next. Show this; never parse it. |
| `retryable` | `true` when the same request may succeed later. |
| `parts` | `PARTS_MISSING` only: the part numbers to send again. |
| `file` | In a job, the file the error belongs to: `{ id, name }`. |
| `status`, `storageCode` | On the server only: the storage service's HTTP status and own error code, for logs. Never shown to users. |

```ts
const { data, error } = await upload("avatar", file);
if (error) {
  if (error.code === "FILE_TOO_LARGE") showError("Pick a file under 5 MB."); // your app's error display
  else showError(error.message);
}
```

Messages never contain credentials, presigned URLs or raw storage responses. The handler sends a client only an error's
`code`, `message`, `retryable` and `parts`; everything else goes to your server's `logger`.

**The client has already retried.** A retryable error that reaches your code has been through the client's attempts
(up to 6 per request, with backoff). Offer the user a retry button rather than retrying in a loop: `retry()` on a job or
file reuses what is already stored in the bucket (see [Client](client.md#retry)).

**Configuration errors are thrown.** `INVALID_CONFIG` is the one code that is thrown instead of returned: it needs a
code change, not a retry.

## How errors travel

1. **Storage driver.** The storage service answers, and the driver turns its answer into a code such as
   `STORAGE_DENIED` or `RATE_LIMITED`. You see these codes directly from `cloudrop.api` calls.
2. **Server handler.** Before a storage failure reaches a browser, the handler logs the full error and replaces it with
   one of two codes: `RATE_LIMITED` ("The storage service is busy") when the storage was throttling, otherwise
   `STORAGE_ERROR`, retryable when the storage failure was. A browser never sees `STORAGE_DENIED`,
   `STORAGE_UNREACHABLE`, `INVALID_PART` or `CHECKSUM_MISMATCH`.
3. **Client.** The client adds four codes of its own (`UPLOAD_REJECTED`, `ABORTED`, `NETWORK_ERROR`, `UPLOAD_IN_USE`) and
   uses a few shared codes for its own failures, such as `STORAGE_ERROR` when the browser's storage fails.

The HTTP status in the tables is what the handler answers with that code.

## Upload endpoint errors

These come from the handler, in answer to `/upload`, `/sign`, `/complete` or `/abort`.

| Code | HTTP | Retryable | What it means | What to do |
| --- | --- | --- | --- | --- |
| `UNAUTHORIZED` | 401 | No | `authorize` returned `unauthorized()`, or a plugin refused with this code. The message is the one `authorize` or the plugin gave. | Show the message; the user usually needs to sign in. |
| `FORBIDDEN` | 403 | No | `authorize` returned `forbidden()`, or a plugin refused with this code: the user is signed in but may not upload this, such as over a quota or on the wrong plan. | Show the message, which says what to do. Signing in again does not help. |
| `ORIGIN_NOT_ALLOWED` | 403 | No | The request came from an origin the handler does not accept. | Add the page's origin to `trustedOrigins`. Behind a proxy, add the app's public origin (see [Troubleshooting](troubleshooting.md#every-request-gets-origin_not_allowed)). |
| `METHOD_NOT_ALLOWED` | 405 | No | The request was not `POST` (or an `OPTIONS` preflight). | Send `POST`. Check that nothing else is mounted at the same path. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | No | The body was not sent as `Content-Type: application/json`. | Send JSON. The cloudrop client always does; check a proxy or custom client. |
| `BODY_TOO_LARGE` | 413 | No | The request body is over 64 KiB. | Send fewer files in one call. |
| `UNKNOWN_ROUTE` | 404 | No | No route has that name, or the token's route was removed or renamed by a deploy. | Check the route name. For an old token, start a new upload. |
| `INVALID_METADATA` | 400 | No | The metadata failed the route's schema, is over 2 KiB as JSON, or was sent to a route without a schema. The message names the first problem. | Fix the metadata the page sends. |
| `TOO_MANY_FILES` | 400 | No | More files than the route's `maxFiles` in one `/upload`. Refuses the whole job. | Send fewer files at once, or raise `maxFiles`. |
| `FILE_TOO_LARGE` | 400 | No | A file is over the route's `maxSize`. Refuses that file only. | Ask the user for a smaller file. |
| `FILE_TYPE_NOT_ALLOWED` | 400 | No | A file's type is not in `accept`, is not a valid MIME type, or its extension does not match its type. Refuses that file only. | Ask the user for another file, or rename it so the extension matches. |
| `QUOTA_EXCEEDED` | 403 | No | With a database store and `quota`: the file would take its owner past their storage limit (reserved plus stored bytes). Refuses that file only; the others of the same `/upload` may fit. | Show the message. The user frees space or the app raises their `quota`; then start the upload again. |
| `INVALID_TOKEN` | 400 | No | The upload token is not valid: not signed by a configured secret, or damaged. | Start the upload again. The client's `retry()` does this. |
| `UPLOAD_EXPIRED` | 410 | No | The upload's 24-hour token has expired. With a database store also "This upload was cancelled or has expired": the file's row was ended by `/abort`, `api.revokeUploads`, a refusal or the sweep, or the database has no row for it. | Start the upload again. The client's `retry()` does this, through `authorize`, so a signed-out user is refused. |
| `NOT_UPLOADED` | 409 | No | `/complete` found no object for a single `PUT`. | Upload the file, then complete it. The client does this in order. |
| `PARTS_MISSING` | 409 | No | `/complete` found parts missing or of the wrong size. `parts` lists them. | Nothing: the client sends those parts again and completes, at most twice. |
| `VERIFICATION_FAILED` | 422 | No | The stored file's size or type does not match what was declared, so it was deleted; or another file is stored under this upload's key. | Start a new upload. `retry()` asks for a new ticket. |
| `NO_SUCH_UPLOAD` | 410 | No | The multipart upload no longer exists: it was aborted or expired. | Start a new upload. `retry()` and `resume()` ask for a new ticket. |
| `ALREADY_EXISTS` | 409 | No | Another file already has this multipart upload's key. | Start a new upload. With a custom `key`, make keys unique. |
| `RATE_LIMITED` | 503 | Yes | The storage service was throttling while the server called it. | Try again in a moment. |
| `STORAGE_ERROR` | 502 | Sometimes | The server's call to the storage service failed (retryable), or the storage refused it (not retryable). Your server log has the details. | When retryable, try again. Otherwise check the server log: often credentials, permissions or the bucket name. |
| `SERVER_ERROR` | 500 | Sometimes | Something in the server failed: your `authorize`, `owner`, `onComplete` or a plugin threw, or cloudrop hit a bug. Retryable when the file is stored but `onComplete` or a hook did not finish, and while an environment setting is missing. With a database store, also retryable when the store failed ("could not reach its upload records"), when `quota` failed ("could not check your storage limit"), and while another request is completing the same file ("Another request is completing this upload", sent with `Retry-After: 2` and not logged). | Check the server log. When retryable, try again; the client does. |
| `NOT_FOUND` | 404 | No | There is no cloudrop endpoint at the requested path. | Check that `basePath` matches on the server and the client. |
| `INVALID_INPUT` | 400 | No | The request body is malformed: not a JSON object, no route name, no files, a bad file entry, wrong part numbers. The Node adapter also answers it for a request it cannot read. | Use the cloudrop client, or fix the request your own client sends. |

## Client errors

These come from `cloudrop/client`. The first four never come from the server.

| Code | Retryable | What it means | What to do |
| --- | --- | --- | --- |
| `NETWORK_ERROR` | Yes | No answer after every attempt: your server could not be reached, or the file could not reach the bucket. A bucket that refuses a `PUT` without CORS headers looks the same to a browser. | Check the connection and retry. If every upload ends this way, check the bucket's CORS rule first (see [Troubleshooting](troubleshooting.md#every-upload-ends-in-network_error)). |
| `UPLOAD_REJECTED` | No | The bucket refused the bytes as signed: a different size, type or checksum, a link refused even after renewal, or another refusal. | Start a new upload; `retry()` asks for a new ticket. When it keeps happening, check the server's clock and the credentials' permissions. |
| `ABORTED` | No | The upload was cancelled through `abort()` or the `signal`. | Nothing, unless the user wants to start again. |
| `UPLOAD_IN_USE` | No | `resume()` found the upload held in this page or another tab. | Finish or cancel it there, then try again. |
| `RATE_LIMITED` | Yes | The bucket answered `429` or `503` to every attempt, or a proxy in front of your server answered `429`. | Try again in a moment. |
| `STORAGE_ERROR` (from the bucket) | Yes | The bucket answered a `PUT` with `408` or a `5xx` other than `501` on every attempt. A `501` ends the file with `UPLOAD_REJECTED` instead. | Retry the upload. |
| `STORAGE_ERROR` (from your server) | Yes / No | Your server's call to the storage service failed or was refused, as in the [endpoint table](#upload-endpoint-errors): such as bad credentials, or Wrangler's local R2 refusing a multipart completion. | When retryable, retry. Otherwise check the server log. |
| `STORAGE_ERROR` (browser storage) | No | The browser's storage for unfinished uploads could not be read or written. Only `resumable()`, `forget()` and `resume()` answer it. | Nothing for the upload: a browser storage failure never stops uploads; only resuming after a reload may not work. |
| `SERVER_ERROR` | When HTTP 500+ | Your server sent an answer the client cannot read: a wrong `basePath`, a proxy's error page, or another cloudrop version. | Check that `basePath` points at the cloudrop handler and that server and client run the same cloudrop version. |
| `NOT_FOUND` | No | `resume()` found no unexpired record of that upload: it finished, was cancelled or expired, or persistence is off. | Start the upload again with `start()` or `upload()`. |
| `INVALID_INPUT` | No | Wrong arguments: no route name, no `File`, options that are not an object, a `signal` that is not an `AbortSignal`, metadata that JSON cannot encode, a different file passed to `resume()`, or a wrong argument to `forget()`. | Fix the call. For `resume()`, ask the user to pick the same file again. |

A code the client does not know, from a newer server, passes through with its message.

## Storage driver and file API errors

These come from the storage driver, which you meet through `cloudrop.api` and in your server log. The handler turns
them into `RATE_LIMITED` or `STORAGE_ERROR` before a browser sees them (see [How errors travel](#how-errors-travel)).

| Code | Retryable | What it means | What to do |
| --- | --- | --- | --- |
| `INVALID_INPUT` | No | A bad argument: an invalid key, an `expiresIn` out of range, a `deletePrefix` prefix not ending in `/`, non-exact origins for `checkBucket`, or a size over the storage's limit. | Fix the argument; the message names it. |
| `STORAGE_UNREACHABLE` | Yes | The storage service could not be reached, or did not answer in time. | Check the endpoint and the network, then retry. |
| `STORAGE_DENIED` | No | The storage service refused the request: wrong access key, missing permission or wrong bucket name; or this server's clock is more than 15 minutes off; or a signed request expired. | Check the credentials, their permissions and the bucket name. For a clock error, sync the clock (NTP). |
| `STORAGE_ERROR` | Sometimes | The storage failed (retryable), the bucket does not exist, the storage does not support the request (such as Wrangler's local R2 and `ListParts`), or another refusal. | When retryable, retry. Otherwise follow the message. |
| `RATE_LIMITED` | Yes | The storage service is throttling (`429` or `503`). | Retry after a short delay. |
| `NOT_FOUND` | No | The object does not exist. | Check the key. `head()` answers `null` instead, and `delete()` succeeds. |
| `ALREADY_EXISTS` | No | A create-only write found an object with this key. | Choose a different key. |
| `NO_SUCH_UPLOAD` | No | The multipart upload no longer exists. | Start a new upload. |
| `INVALID_PART` | No | Parts are missing or have the wrong size at completion. | Upload them again, then complete. In `/complete`, the handler answers a retryable `STORAGE_ERROR` instead. |
| `CHECKSUM_MISMATCH` | No | The uploaded bytes do not match their checksum. | Upload them again. |

## Configuration errors

| Code | Thrown by | What to do |
| --- | --- | --- |
| `INVALID_CONFIG` | `createCloudrop`, `route`, `r2`, `s3`, `createCloudropClient`, `toNextHandler`, `toNodeHandler`, and a plugin's `extendRoute` | Fix the option the message names. A missing setting names its environment variable when there is one. |

Settings read from the environment (`CLOUDROP_SECRET`, `CLOUDROP_R2_*`, `CLOUDROP_S3_*`) are reported on the first
request instead of thrown, and `INVALID_CONFIG` then arrives in a result: the handler logs it (again only when the
message changes) and answers every request with a retryable `SERVER_ERROR` 500, every `cloudrop.api` call returns
`{ data: null, error }` with it, and a storage preset's own methods return it until its settings are complete. See
[Every request answers 500](troubleshooting.md#every-request-answers-500-server_error).

Why errors work this way: the error decisions in [docs/decisions](../decisions/README.md) and the design's
[failure classifier](../superpowers/specs/2026-11-15-cloudrop-design.md#62-failure-classifier).
