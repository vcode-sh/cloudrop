// The entries of a route's `accept` and matching a type against them, apart from accept.ts so that cloudrop/plugins
// can use them without accept.ts's extension table.

// RFC 6838 type and subtype names in lower case, a top-level wildcard such as "image/*", or "*/*".
const ACCEPT_ENTRY = /^(\*\/\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/(\*|[a-z0-9][a-z0-9!#$&^_.+-]{0,63}))$/;

export function isAcceptEntry(entry: string): boolean {
  return ACCEPT_ENTRY.test(entry);
}

/** Whether `type` (normalized) matches an entry of `accept`: "*\/*", the type itself, or its top-level "image/*". */
export const acceptsType = (accept: readonly string[], type: string): boolean =>
  accept.some(
    (entry) => entry === "*/*" || entry === type || (entry.endsWith("/*") && type.startsWith(entry.slice(0, -1))),
  );
