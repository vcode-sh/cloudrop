// What every group of contract cases shares: the connected backend, its driver and the helpers that send requests.

import type { TestContext } from "vitest";
import type { StorageDriver } from "../../storage/driver.ts";
import type { ContractTarget, Gap, OpenUpload } from "../storage-contract.ts";

/** Test bytes in which each 4-byte word holds its own offset, big-endian: no two words repeat within 4 GiB. */
export function offsetBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  const view = new DataView(out.buffer);
  for (let offset = 0; offset + 4 <= length; offset += 4) view.setUint32(offset, offset);
  return out;
}

export const etagOf = (response: Response): string => (response.headers.get("etag") ?? "").replaceAll('"', "");

/** Status and S3 error code of a raw response; reading the body also releases the connection. */
export async function outcome(response: Response): Promise<{ status: number; code: string }> {
  const code = /<Code>([^<]*)<\/Code>/.exec(await response.text())?.[1] ?? "";
  return { status: response.status, code };
}

export const text = (bytes: Uint8Array | null): string => new TextDecoder().decode(bytes ?? new Uint8Array());

/** The connected backend as the cases see it. `target` and `driver` are read inside a case, once connected. */
export interface ContractSuite {
  readonly target: ContractTarget;
  readonly driver: StorageDriver;
  key(suffix: string): string;
  partSize(): number;
  skipWithout(ctx: TestContext, ...needed: Gap[]): void;
  uploadAfterCompletion(): string | undefined;
  startUpload(suffix: string, metadata?: Record<string, string>): Promise<{ k: string; uploadId: string }>;
  sendPart(
    k: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array<ArrayBuffer>,
    checksumCrc32c?: string,
  ): Promise<Response>;
  signedPut(
    k: string,
    options: Parameters<StorageDriver["presignPut"]>[1],
    via?: StorageDriver,
  ): Promise<(body: Uint8Array<ArrayBuffer>, extraHeaders?: Record<string, string>) => Promise<Response>>;
}

/** Builds the shared helpers over the target `connected` returns; uploads they open are recorded for teardown. */
export function contractSuite(connected: () => ContractTarget, openUploads: OpenUpload[]): ContractSuite {
  const driver = (): StorageDriver => connected().driver;
  const key = (suffix: string): string => `${connected().prefix}${suffix}`;
  return {
    get target() {
      return connected();
    },
    get driver() {
      return driver();
    },
    key,
    // Every size derives from the backend's own minimum part size: the smallest multipart upload it accepts.
    partSize: () => driver().rules.minPartSize,
    skipWithout(ctx, ...needed) {
      const reason = needed.map((gap) => connected().gaps[gap]).find((entry) => entry !== undefined);
      ctx.skip(reason !== undefined, reason);
    },
    // The error a finished upload ID answers on a second completion: R2 forgets it at once, a lingering backend completes again.
    uploadAfterCompletion: () => (connected().gaps.finishedUploadsLinger === undefined ? "NO_SUCH_UPLOAD" : undefined),
    async startUpload(suffix, metadata) {
      const k = key(suffix);
      const created = await driver().createMultipart(k, { type: "application/octet-stream", metadata });
      if (created.error) throw created.error;
      openUploads.push({ key: k, uploadId: created.data.uploadId });
      return { k, uploadId: created.data.uploadId };
    },
    // Signing a part with the upload ID the backend returned also proves that ID passes the driver's validation.
    async sendPart(k, uploadId, partNumber, body, checksumCrc32c) {
      const signed = await driver().presignPart(k, uploadId, partNumber, {
        size: body.length,
        expiresIn: 300,
        checksumCrc32c,
      });
      if (signed.error) throw signed.error;
      return connected().http(signed.data.url, { method: "PUT", headers: signed.data.headers, body });
    },
    /** Presigns a PUT and returns a sender for that one URL, optionally with headers it did not sign. */
    async signedPut(k, options, via = driver()) {
      const signed = await via.presignPut(k, options);
      if (signed.error) throw signed.error;
      const { url, headers } = signed.data;
      return (body, extraHeaders = {}) =>
        connected().http(url, { method: "PUT", headers: { ...headers, ...extraHeaders }, body });
    },
  };
}
