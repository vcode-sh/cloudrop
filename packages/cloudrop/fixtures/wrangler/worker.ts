// The Worker only exists so Wrangler serves the local R2 S3 endpoint; the contract talks to that endpoint.
// It uses no Workers-specific types, and neither tsconfig includes this folder, so library source never sees them.
export default { fetch: (): Response => new Response("cloudrop contract worker") };
