# M12-E: server refusals

Rulings for how the server refuses and what a client can read from a refusal: a `CloudropError` returned from
`authorize`, `rateLimited(seconds)`, `Retry-After` on the 200 that refuses a file, `kind` on a content refusal, and
`BUCKET_BLOCKED` for a bucket the browser cannot reach, designed in `docs/superpowers/specs/2026-11-22-1.0.0-design.md`
§2.
Each entry: Decision, Why, If wrong, Status, Visible in.
Entries start from 1.
