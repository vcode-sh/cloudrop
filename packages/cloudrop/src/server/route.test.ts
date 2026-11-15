import { describe, expect, it } from "vitest";
import { isUnauthorized, unauthorized } from "./route.ts";

describe("isUnauthorized", () => {
  it.for([
    { name: "unauthorized()", value: unauthorized("Sign in first."), refused: true },
    // What a second installed copy of cloudrop returns: its own module, the same registered symbol.
    {
      name: "a refusal from another copy of cloudrop",
      value: { [Symbol.for("cloudrop.unauthorized")]: true, message: "Sign in first." },
      refused: true,
    },
    // A null prototype is as plain as Object.prototype.
    {
      name: "a branded object without a prototype",
      value: Object.assign(Object.create(null), { [Symbol.for("cloudrop.unauthorized")]: true, message: "x" }),
      refused: true,
    },
    // Only cloudrop's brand refuses; an authorize result that merely has a message is a user.
    { name: "an object with only a message", value: { message: "Sign in first." }, refused: false },
    // Only a plain object can be a refusal, so a branded class instance never reads as one.
    {
      name: "an Error carrying the brand",
      value: Object.assign(new Error("Sign in first."), { [Symbol.for("cloudrop.unauthorized")]: true }),
      refused: false,
    },
  ])("recognises $name: $refused", ({ value, refused }) => {
    expect(isUnauthorized(value)).toBe(refused);
  });
});
