# cloudrop

Fast, resumable, direct-to-bucket file uploads for Cloudflare R2 and S3-compatible storage.

Status: early development. Nothing usable is published yet; `cloudrop@0.0.0` on npm only reserves the name.

## Goals

- Headless core with a small footprint, plus thin React, Vue and Svelte bindings.
- R2-correct multipart uploads (equal part sizes), adaptive concurrency, retries, pause, resume and abort.
- Resume after a page reload.
- One framework-agnostic server handler (`Request` in, `Response` out) that signs uploads, requires authorization
  and verifies size and type on completion.
- Tested against real R2 and several S3-compatible servers.

Background research: [`docs/research`](docs/research).

Not affiliated with Cloudflare.

## License

[MIT](LICENSE)
