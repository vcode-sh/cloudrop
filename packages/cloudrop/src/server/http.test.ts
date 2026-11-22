// errorBody is the last gate before an error reaches a browser (M11-K3): the refusal paths rebuild what plugins and
// hooks return, and this keeps a future path that forgets to from sending what it should not (M12-R31).

import { describe, expect, it } from "vitest";
import { CloudropError } from "../errors.ts";
import { errorBody } from "./http.ts";

describe("errorBody", () => {
  it.for([
    {
      name: "PARTS_MISSING's part numbers, without what is not one",
      error: new CloudropError("PARTS_MISSING", "Upload them again.", { parts: [2, 0, -1, 1.5, "3", 5] as never }),
      body: { code: "PARTS_MISSING", message: "Upload them again.", retryable: false, parts: [2, 5] },
    },
    {
      name: "no parts with another code",
      error: new CloudropError("FORBIDDEN", "No.", { parts: [1, 2] }),
      body: { code: "FORBIDDEN", message: "No.", retryable: false },
    },
  ])("sends $name", ({ error, body }) => {
    expect(errorBody(error)).toStrictEqual(body);
  });
});
