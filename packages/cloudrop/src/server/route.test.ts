import { describe, expect, it } from "vitest";
import { allowAnyone, forbidden, isRefusal, route, unauthorized } from "./route.ts";

describe("isRefusal", () => {
  it.for([
    { name: "unauthorized()", value: unauthorized("Sign in first."), refused: true },
    { name: "forbidden()", value: forbidden("Your plan stores 1 GB."), refused: true },
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
    expect(isRefusal(value)).toBe(refused);
  });
});

// JavaScript callers get no type error for an option in the wrong argument; the option would silently do nothing.
describe("route() options in the wrong argument", () => {
  const policy = { accept: "*/*", maxSize: 1, authorize: allowAnyone };

  it.for([
    {
      name: "prefix in the policy",
      // @ts-expect-error: prefix is typed from authorize's result, so it belongs in the second argument.
      make: () => route({ ...policy, prefix: () => "users" }),
      message:
        "route(): prefix belongs in the second argument, which holds prefix, key, owner, onComplete and afterComplete: route({ accept, maxSize, authorize }, { prefix }).",
    },
    {
      name: "onComplete in the policy",
      // @ts-expect-error: onComplete belongs in the second argument.
      make: () => route({ ...policy, onComplete: () => null }),
      message:
        "route(): onComplete belongs in the second argument, which holds prefix, key, owner, onComplete and afterComplete: route({ accept, maxSize, authorize }, { onComplete }).",
    },
    {
      name: "accept in the callbacks",
      // @ts-expect-error: accept belongs in the first argument.
      make: () => route(policy, { accept: "image/*" }),
      message:
        "route(): accept belongs in the first argument, which holds accept, maxSize, maxFiles, metadata, visibility, replace and authorize. The second takes only prefix, key, owner, onComplete and afterComplete.",
    },
    {
      name: "authorize in the callbacks",
      // @ts-expect-error: authorize belongs in the first argument.
      make: () => route(policy, { authorize: allowAnyone }),
      message:
        "route(): authorize belongs in the first argument, which holds accept, maxSize, maxFiles, metadata, visibility, replace and authorize. The second takes only prefix, key, owner, onComplete and afterComplete.",
    },
  ])("throws INVALID_CONFIG for $name, naming where it belongs", ({ make, message }) => {
    expect(make).toThrow(expect.objectContaining({ code: "INVALID_CONFIG", message }));
  });
});
