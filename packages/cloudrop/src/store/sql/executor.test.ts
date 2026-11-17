// The SQLSTATE checks on every error shape a shipped executor or adapter throws. The Prisma shapes were measured on
// Postgres 18 through @prisma/adapter-pg 7.10.1 (raw queries failing with 55P03 and 23505): the adapter names the
// errors it maps (23505 becomes kind "UniqueConstraintViolation", without `code`), and keeps the SQLSTATE as
// `originalCode` on every one.

import { expect, test } from "vitest";
import { isLockTimeout, isUniqueViolation } from "./executor.ts";

/** Prisma's error for a failed raw query, the driver adapter's error under meta. */
const prismaRawQueryError = (cause: Record<string, unknown>) =>
  Object.assign(new Error("Invalid `prisma.$queryRawUnsafe()` invocation: Raw query failed."), {
    code: "P2010",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause } },
  });

test.each([
  {
    name: "node-postgres or postgres.js, lock timeout",
    error: Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
    lockTimeout: true,
    uniqueViolation: false,
  },
  {
    name: "node-postgres or postgres.js, unique violation",
    error: Object.assign(new Error('duplicate key value violates unique constraint "cloudrop_usage_pkey"'), {
      code: "23505",
    }),
    lockTimeout: false,
    uniqueViolation: true,
  },
  {
    name: "Drizzle's query error around the driver's lock timeout",
    error: new Error("Failed query: UPDATE …", { cause: { code: "55P03" } }),
    lockTimeout: true,
    uniqueViolation: false,
  },
  {
    name: "Prisma's P2010, lock timeout",
    error: prismaRawQueryError({
      originalCode: "55P03",
      originalMessage: "canceling statement due to lock timeout",
      kind: "postgres",
      code: "55P03",
      severity: "ERROR",
      message: "canceling statement due to lock timeout",
    }),
    lockTimeout: true,
    uniqueViolation: false,
  },
  {
    name: "Prisma's P2010, unique violation (no code, only originalCode)",
    error: prismaRawQueryError({
      originalCode: "23505",
      originalMessage: 'duplicate key value violates unique constraint "cloudrop_usage_pkey"',
      kind: "UniqueConstraintViolation",
      constraint: { index: "cloudrop_usage_pkey" },
      table: "cloudrop_usage",
    }),
    lockTimeout: false,
    uniqueViolation: true,
  },
])("$name: lock timeout $lockTimeout, unique violation $uniqueViolation", (row) => {
  expect([isLockTimeout(row.error), isUniqueViolation(row.error)]).toEqual([row.lockTimeout, row.uniqueViolation]);
});
