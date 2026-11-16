// Requests signed for the fake R2's own tests: a fake whose clock sits a chosen time after signing, presigned PUT URLs
// and header-signed calls, all for the bucket "test".

import { presignUrl, signRequest, UNSIGNED_PAYLOAD } from "../../storage/sigv4.ts";
import { createFakeR2, type FakeR2 } from "../fake-r2.ts";

const credentials = { accessKeyId: "fake-access-key", secretAccessKey: "fake-secret-key" };
export const objectUrl = (key: string): URL => new URL(`https://account.r2.cloudflarestorage.com/test/${key}`);
export const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
export const signedAt: Date = new Date("2026-11-15T12:00:00Z");

export async function presignedPut(
  key: string,
  headers: Record<string, string>,
  options: { secret?: string; date?: Date; expiresIn?: number } = {},
): Promise<URL> {
  return presignUrl({
    method: "PUT",
    url: objectUrl(key),
    headers,
    credentials: { ...credentials, secretAccessKey: options.secret ?? credentials.secretAccessKey },
    region: "auto",
    date: options.date ?? signedAt,
    expiresIn: options.expiresIn ?? 60,
  });
}

export function fakeAt(secondsAfterSigning = 0): FakeR2 {
  return createFakeR2({
    bucket: "test",
    credentials,
    now: () => new Date(signedAt.getTime() + secondsAfterSigning * 1000),
  });
}

export interface SignedOptions {
  body?: Uint8Array<ArrayBuffer>;
  headers?: Record<string, string>;
  secret?: string;
  date?: Date;
  payloadHash?: string;
}

// A header-signed server-side request, the way the storage driver talks to the bucket.
export async function signed(
  method: string,
  pathAndQuery: string,
  options: SignedOptions = {},
): Promise<{ url: URL; headers: Record<string, string> }> {
  const url = new URL(`https://account.r2.cloudflarestorage.com/test${pathAndQuery}`);
  const headers = await signRequest({
    method,
    url,
    headers: options.headers,
    credentials: { ...credentials, secretAccessKey: options.secret ?? credentials.secretAccessKey },
    region: "auto",
    date: options.date ?? signedAt,
    payloadHash: options.payloadHash ?? UNSIGNED_PAYLOAD,
  });
  return { url, headers };
}

export async function call(
  fake: FakeR2,
  method: string,
  pathAndQuery: string,
  options: SignedOptions = {},
): Promise<Response> {
  const { url, headers } = await signed(method, pathAndQuery, options);
  return fake.fetch(url, { method, headers, body: options.body });
}

export const code = async (response: Response): Promise<string | undefined> =>
  /<Code>(.*?)<\/Code>/.exec(await response.text())?.[1];
