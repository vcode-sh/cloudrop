// prismaStore's construction-time refusals, and its types against Prisma's own declarations: `bun run typecheck`
// compiles this file, so every expectTypeOf and expect-error directive is an assertion. What the store does on a
// database is proven in prisma.db.integration.test.ts and prisma-handler.db.integration.test.ts.

import { describe, expect, expectTypeOf, test } from "vitest";
import { type PrismaClientLike, prismaStore } from "./prisma.ts";

// The members of a generated client the types depend on, as Prisma 7.10.1 declares them
// (.prisma-client/*/internal/class.ts): the array form first, the callback form last, and the callback's client
// without the members Prisma denies inside a transaction (`denylist` in @prisma/client/runtime/client.d.ts).
interface PrismaPromise<T> extends Promise<T> {
  [Symbol.toStringTag]: "PrismaPromise";
}
type TransactionIsolationLevel = "ReadUncommitted" | "ReadCommitted" | "RepeatableRead" | "Serializable";
type ITXClientDenyList = "$connect" | "$disconnect" | "$on" | "$use" | "$extends";
declare class PrismaClient {
  avatar: { create(args: { data: { userId: string; key: string } }): PrismaPromise<{ id: number }> };
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $on(event: "query", callback: () => void): void;
  $extends(extension: object): this;
  $executeRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PrismaPromise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): PrismaPromise<T>;
  $transaction<P extends PrismaPromise<unknown>[]>(
    arg: [...P],
    options?: { maxWait?: number; timeout?: number; isolationLevel?: TransactionIsolationLevel },
  ): Promise<{ [K in keyof P]: Awaited<P[K]> }>;
  $transaction<R>(
    fn: (prisma: Omit<PrismaClient, ITXClientDenyList>) => Promise<R>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: TransactionIsolationLevel },
  ): Promise<R>;
}

/** Never called: the refusals happen before the store touches its client. */
const client = {} as PrismaClientLike;

describe("prismaStore types", () => {
  test("transaction: true types tx as Prisma's transaction client; without it, or on SQLite, there is no route", () => {
    const prisma = {} as PrismaClient;
    const store = prismaStore(prisma, {
      dialect: "postgres",
      transaction: true,
      transactionOptions: { timeout: 10_000 },
    });
    store.route(
      { accept: "image/*", maxSize: "5MB", authorize: () => ({ userId: "u1" }) },
      {
        onComplete: async ({ tx, userId, file }) => {
          expectTypeOf(tx).toEqualTypeOf<Omit<PrismaClient, ITXClientDenyList>>();
          await tx.avatar.create({ data: { userId, key: file.key } });
          // @ts-expect-error: Prisma denies $disconnect inside an interactive transaction.
          void tx.$disconnect;
          return null;
        },
      },
    );
    expectTypeOf(store.transaction).toBeFunction();

    const leased = prismaStore(prisma, { dialect: "postgres" });
    // @ts-expect-error: without transaction: true there is no tx to type a route with.
    void leased.route;

    // @ts-expect-error: transaction mode is Postgres only.
    void (() => prismaStore(prisma, { dialect: "sqlite", transaction: true }));
    // @ts-expect-error: transactionOptions needs transaction: true.
    void (() => prismaStore(prisma, { dialect: "postgres", transactionOptions: { timeout: 1 } }));
  });
});

test.each([
  {
    name: "a dialect other than postgres or sqlite",
    options: { dialect: "mysql" },
    message:
      'prismaStore() got dialect "mysql". Pass { dialect: "postgres" } or { dialect: "sqlite" }, matching your Prisma datasource.',
  },
  {
    name: "transaction: true on SQLite",
    options: { dialect: "sqlite", transaction: true },
    message:
      "transaction: true needs Postgres. SQLite has one writer at a time, so a transaction held open while onComplete runs would stall every other upload; leave the option out and completions use a lease.",
  },
  {
    name: "tables.schema on SQLite, which has no schemas",
    options: { dialect: "sqlite", tables: { schema: "app" } },
    message:
      "SQLite has no schemas, so { tables: { schema } } applies only to Postgres. Remove schema from { tables }; SQLite finds the tables by their names alone.",
  },
  {
    name: "transactionOptions without transaction: true",
    options: { dialect: "postgres", transactionOptions: { timeout: 10_000 } },
    message:
      "prismaStore(): transactionOptions applies only with transaction: true. Add transaction: true, or remove transactionOptions.",
  },
])("refuses $name with INVALID_CONFIG", ({ options, message }) => {
  // Plain JavaScript callers can pass what the types refuse.
  expect(() => prismaStore(client, options as never)).toThrow(
    expect.objectContaining({ code: "INVALID_CONFIG", message }),
  );
});
