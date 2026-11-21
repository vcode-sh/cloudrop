import { CloudropError, ok, type Result } from "../../errors.ts";
import { stripQuotes, xmlValue } from "../xml.ts";

export const etagIn = (xml: string): string => stripQuotes(xmlValue(xml, "ETag") ?? "");

/** The ETag header without its quotes: "" when it is missing, or weak (`W/"…"`), which a web host sends and S3 never does. */
export function etagOf(headers: Headers): string {
  const etag = headers.get("etag") ?? "";
  return etag.startsWith("W/") ? "" : stripQuotes(etag);
}

/** A 2xx response without a field cloudrop needs: a fault on the storage side, worth a retry. */
export function incompleteResponse(missing: string): CloudropError {
  return new CloudropError("STORAGE_ERROR", `The storage service's response had no ${missing}. Retry the request.`, {
    retryable: true,
  });
}

/** A count or a size read from a storage answer: a whole number a JavaScript number holds exactly. */
export function wholeNumber(text: string | null | undefined): number | undefined {
  if (text == null || !/^\d+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function validDate(text: string | null | undefined): Date | undefined {
  const date = new Date(text ?? Number.NaN);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The first failure among the results, or all their values. */
export function allOk<T>(results: Result<T>[]): Result<T[]> {
  const values: T[] = [];
  for (const result of results) {
    if (result.error) return result;
    values.push(result.data);
  }
  return ok(values);
}
