# Slop checklist (S1–S11)

Patterns AI-written code leaves behind. Check every row against every changed file before you simplify anything else.
Each fix is a deletion or a small rewrite, never a new abstraction. Function names in the examples are placeholders.

| # | Pattern | Fix |
| --- | --- | --- |
| S1 | Comment that restates the next line, or cites a task, plan or PR. | Delete it. Keep comments that say *why*. |
| S2 | `try/catch` that only logs and rethrows, swallows, or returns a default. | Delete it, or handle a named failure by mapping it to a `CloudropError` code. |
| S3 | Null or type checks on values the types already guarantee. | Delete; trust the types. Checks at the public boundary stay (callers may not use TypeScript). |
| S4 | Options, flags, parameters or config no caller passes. | Delete. An exported option is a semver commitment. |
| S5 | Pass-through function, wrapper, or single-implementation interface or factory that adds a hop and no decision. | Inline. The `StorageDriver` interface (two implementations) and preset factories (`r2()`, `s3()`) are not this. |
| S6 | A helper that already exists elsewhere. | Search first (`rg`), reuse the owner. |
| S7 | Types re-declared by hand next to the value or schema they describe. | `typeof value`, or the schema's inferred type. |
| S8 | A cache, memo table or precomputed lookup added without a measurement. | Delete, or keep with the number that justifies it in a comment. |
| S9 | A hand-written helper for something the web platform ships (`TextEncoder`, `URL`, `crypto.subtle`, `Uint8Array.prototype.set`, `AbortSignal.timeout`). | Use the platform API. |
| S10 | Dead exports, files and dependencies. | Unexport or delete a dead export after checking runtime imports and the `package.json` `exports` map. A whole file or dependency only when provably dead **and** not a convention ([simplify-rule.md](simplify-rule.md#deleting-a-whole-file-or-dependency)); otherwise list it for owner confirmation. |
| S11 | Messages that leak internals or say only "Something went wrong". | Rewrite per [human-friendly.md](human-friendly.md#messages). |

## Before and after

**S1**

```ts
// Before
// Create the driver
const driver = createS3Driver(options);

// After
const driver = createS3Driver(options);
```

**S2**

```ts
// Before
try {
  return await send(request);
} catch (error) {
  console.error("request failed", error);
  throw error;
}

// After: the caller gets the failure, mapped to a CloudropError where it is expected
return await send(request);
```

**S3**

```ts
// Before: `size` is typed `number` and already validated by the entry function
if (size === undefined || typeof size !== "number") {
  throw new Error("size is required");
}

// After: the type already rejected it
```

**S4**

```ts
// Before: no caller passes `retries`
export function createDriver(options: DriverOptions, extra: { retries?: number } = {}) {}

// After
export function createDriver(options: DriverOptions) {}
```

**S7**

```ts
// Before
interface UploadRules {
  maxSize: number;
}
const RULES = { maxSize: 5 * GiB };

// After
const RULES = { maxSize: 5 * GiB };
type UploadRules = typeof RULES;
```

**S9**

```ts
// Before: manual loop
const bytes = new Uint8Array(text.length);
for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);

// After: correct for non-ASCII too
const bytes = new TextEncoder().encode(text);
```

**S11**

```ts
// Before
throw new CloudropError({ code: "STORAGE_ERROR", message: `S3 returned 403: ${body}` });

// After
throw new CloudropError({
  code: "STORAGE_DENIED",
  message: "The storage credentials were rejected. Check the access key and the bucket permissions.",
});
```
