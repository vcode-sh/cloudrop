import { describe, expect, it } from "vitest";
import { importTokenKey, signToken, type UploadTokenPayload, verifyToken } from "./token.ts";

// Independent oracle: both tokens were computed outside cloudrop, with Python's hmac module (hashlib.sha256 over the
// base64url payload, base64url without padding) and cross-checked with `openssl dgst -sha256 -hmac`.
const CURRENT = "current-secret-0123456789abcdef0123";
const PREVIOUS = "previous-secret-0123456789abcdef012";
const BODY =
  "eyJ2IjoxLCJyb3V0ZSI6ImF2YXRhciIsImZpbGVJZCI6IjAxSkNaNFczVDVROEY3WEtBSjBQOVMyVkhNIiwia2V5IjoidXNlcnMvNDIvMDFKQ1o0VzNUNVE4RjdYS0FKMFA5UzJWSE0ucG5nIiwibmFtZSI6Im1lLnBuZyIsInNpemUiOjEwMjQsInR5cGUiOiJpbWFnZS9wbmciLCJvd25lciI6eyJ1c2VySWQiOiI0MiJ9LCJtZXRhZGF0YSI6bnVsbCwiZXhwIjoxNzYzMjUxMjAwfQ";
const SIGNED_WITH_CURRENT = `${BODY}.TjnJ9_yOS-wl8JbH2hG3eJ-cxKbCr3bxboTvaDByGh0`;
const SIGNED_WITH_PREVIOUS = `${BODY}.McDwqT244iJxR43LUsqGbvLfZuPdfzdNvf97CSZ6eVo`;
// 2025-11-16T00:00:00Z.
const EXP = 1_763_251_200;

const payload: UploadTokenPayload = {
  v: 1,
  route: "avatar",
  fileId: "01JCZ4W3T5Q8F7XKAJ0P9S2VHM",
  key: "users/42/01JCZ4W3T5Q8F7XKAJ0P9S2VHM.png",
  name: "me.png",
  size: 1024,
  type: "image/png",
  owner: { userId: "42" },
  metadata: null,
  exp: EXP,
};

const current = await importTokenKey(CURRENT);
const previous = await importTokenKey(PREVIOUS);
const other = await importTokenKey("other-secret-0123456789abcdef012345");

const invalid = { code: "INVALID_TOKEN", message: "The upload token is not valid. Start the upload again." };

describe("signToken", () => {
  it("produces the token computed independently with Python's hmac", async () => {
    expect(await signToken(payload, current)).toBe(SIGNED_WITH_CURRENT);
  });
});

describe("verifyToken", () => {
  it("returns the payload of a token signed with the current secret, one second before it expires", async () => {
    expect(await verifyToken(SIGNED_WITH_CURRENT, [current, previous], EXP - 1)).toEqual({
      data: payload,
      error: null,
    });
  });

  it("accepts a token signed with a previous secret, so rotating secrets keeps live uploads", async () => {
    expect((await verifyToken(SIGNED_WITH_PREVIOUS, [current, previous], EXP - 1)).data).toEqual(payload);
  });

  it("refuses a token signed with a secret that was rotated out", async () => {
    expect((await verifyToken(SIGNED_WITH_PREVIOUS, [current], EXP - 1)).error).toMatchObject(invalid);
  });

  it("refuses a token signed with a secret it does not know", async () => {
    expect((await verifyToken(SIGNED_WITH_CURRENT, [other], EXP - 1)).error).toMatchObject(invalid);
  });

  it("reports a token as expired from its exp second on", async () => {
    expect((await verifyToken(SIGNED_WITH_CURRENT, [current], EXP)).error).toMatchObject({
      code: "UPLOAD_EXPIRED",
      message: "This upload expired. Start it again to upload the file.",
      status: 410,
      retryable: false,
    });
  });

  it("lets abort read an expired token, which only cleans up", async () => {
    expect((await verifyToken(SIGNED_WITH_CURRENT, [current], EXP + 3600, { allowExpired: true })).data).toEqual(
      payload,
    );
  });

  // A large payload with both 2 KiB JSON caps, a 1,024-byte key and a name of 255 control characters. Python's json
  // and base64 give 9,111 characters; quoted keys and a multipart upload ID can make a longer token.
  const largest: UploadTokenPayload = {
    ...payload,
    key: `${"k".repeat(1020)}.bin`,
    name: "\u0001".repeat(255),
    owner: { userId: "u".repeat(2035) },
    metadata: { albumId: "a".repeat(2034) },
  };

  it("verifies a token beyond the former 8 KiB cap", async () => {
    const token = await signToken(largest, current);
    expect(token).toHaveLength(9111);
    expect((await verifyToken(token, [current], EXP - 1)).data).toEqual(largest);
  });

  it("refuses a correctly signed token over 16 KiB before reading it", async () => {
    // 17,066 characters, and the signature is valid: only the length check can refuse it.
    const token = await signToken({ ...largest, metadata: { albumId: "a".repeat(8000) } }, current);
    expect((await verifyToken(token, [current], EXP - 1)).error).toMatchObject(invalid);
  });

  // The payload with "size":1024 replaced by "size":9999, base64url-encoded, keeping the original signature.
  const enlarged = btoa(atob(BODY.replaceAll("-", "+").replaceAll("_", "/")).replace('"size":1024', '"size":9999'))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

  it.for<{ name: string; token: unknown }>([
    { name: "a payload changed after signing", token: `${enlarged}.TjnJ9_yOS-wl8JbH2hG3eJ-cxKbCr3bxboTvaDByGh0` },
    {
      name: "a signature with its first character changed",
      token: `${BODY}.UjnJ9_yOS-wl8JbH2hG3eJ-cxKbCr3bxboTvaDByGh0`,
    },
    // "0" and "1" differ only in the two bits base64 drops after 32 bytes: a byte comparison would accept this spelling.
    { name: "a second spelling of the same signature", token: `${SIGNED_WITH_CURRENT.slice(0, -1)}1` },
    { name: "a truncated signature", token: SIGNED_WITH_CURRENT.slice(0, -2) },
    { name: "no signature", token: BODY },
    { name: "an empty signature", token: `${BODY}.` },
    { name: "a third part", token: `${SIGNED_WITH_CURRENT}.x` },
    { name: "characters outside base64url", token: `${BODY}.TjnJ9/yOS+wl8JbH2hG3eJ-cxKbCr3bxboTvaDByGh0` },
    // Correctly signed with CURRENT (Python's hmac), but not a JSON object: only a holder of the secret can make these.
    { name: "a correctly signed JSON null", token: "bnVsbA.UPMTeJK6Jo-ME4iVa1icIIfVPvbx_cyV5yNnU0CariQ" },
    {
      name: "a correctly signed v1 payload without an expiry",
      token: "eyJ2IjoxfQ.cKv7b5CE1Y-Qy2s8-pafLvehefd6qaybw3MnrqNLJr4",
    },
    {
      name: "a correctly signed body that is not JSON",
      token: "bm90IGpzb24._HmPZd73CUF6zDYT36PMR2Xilwj_15I9y0cb3M21ydM",
    },
    { name: "an empty string", token: "" },
    { name: "a number", token: 42 },
    { name: "null", token: null },
    { name: "an object", token: { token: SIGNED_WITH_CURRENT } },
  ])("refuses $name", async ({ token }) => {
    expect((await verifyToken(token, [current], EXP - 1)).error).toMatchObject(invalid);
  });

  it("refuses a correctly signed token of another version", async () => {
    const future = await signToken({ ...payload, v: 2 } as unknown as UploadTokenPayload, current);
    expect((await verifyToken(future, [current], EXP - 1)).error).toMatchObject(invalid);
  });
});
