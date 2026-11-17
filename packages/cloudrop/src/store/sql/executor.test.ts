// The error tests on Prisma 7's wrapper, which the drivers' rows in the database lane do not reach quickly: measured on
// Postgres 18 through @prisma/adapter-pg 7.10.1 (a raw query failing with 55P03).

import { expect, test } from "vitest";
import { isLockTimeout, isUniqueViolation } from "./executor.ts";

/** Prisma's error for a failed raw query, with the driver adapter's error under meta. */
const prismaRawQueryError = (code: string) =>
  Object.assign(new Error("Invalid `prisma.$queryRawUnsafe()` invocation: Raw query failed."), {
    code: "P2010",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause: { originalCode: code, kind: "postgres", code } } },
  });

test.each([
  { code: "55P03", lockTimeout: true, uniqueViolation: false },
  { code: "23505", lockTimeout: false, uniqueViolation: true },
])("Prisma's P2010 holding $code: lock timeout $lockTimeout, unique violation $uniqueViolation", (row) => {
  const error = prismaRawQueryError(row.code);
  expect([isLockTimeout(error), isUniqueViolation(error)]).toEqual([row.lockTimeout, row.uniqueViolation]);
});
