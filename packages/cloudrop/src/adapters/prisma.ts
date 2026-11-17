// cloudrop/adapters/prisma: the database store over a Prisma 7 client, on Postgres or SQLite (spec M5 §7, M5-T14). The
// SQL core writes every statement; this file runs them through `$queryRawUnsafe` and `$transaction`. The client is
// described by the members called here, so the library imports nothing from Prisma.

import { configError } from "../errors.ts";
import type { CloudropStore, TransactionalStore } from "../server/store.ts";
import { type SqlRow, sequential, type TransactionalSqlExecutor } from "../store/sql/executor.ts";
import { sqlStore } from "../store/sql/store.ts";
import type { StoreTables } from "../store/sql/tables.ts";
import { withRoute } from "./transactional.ts";

export type { StoreTables } from "../store/sql/tables.ts";

/** What the store calls on a Prisma client, or on the client of an interactive transaction. */
export interface PrismaQueryable {
  $queryRawUnsafe(query: string, ...values: unknown[]): PromiseLike<unknown>;
}

/** Prisma's options for an interactive transaction, both in milliseconds. */
export interface PrismaTransactionOptions {
  /** How long to wait for a connection from the pool. Prisma's default is 2000. */
  maxWait?: number;
  /**
   * How long the whole transaction, `onComplete` included, may run before Prisma rolls it back. Prisma's default is
   * 5000; a completion that runs out answers a retryable error and nothing of it is kept.
   */
  timeout?: number;
}

/** A Prisma 7 client, `new PrismaClient({ adapter })`, or one made with `$extends`. */
export interface PrismaClientLike extends PrismaQueryable {
  $transaction(queries: PromiseLike<unknown>[]): Promise<unknown[]>;
  $transaction<T>(run: (tx: PrismaQueryable) => Promise<T>, options?: PrismaTransactionOptions): Promise<T>;
}

/** The client Prisma hands an interactive transaction's callback, as `TClient`'s own type declares it. */
export type PrismaTransactionClient<TClient> = TClient extends {
  // Prisma declares the callback form last, and inference reads the last overload.
  $transaction(run: (tx: infer TTx) => Promise<unknown>, ...rest: never[]): unknown;
}
  ? TTx
  : never;

interface StoreOptionsBase {
  /** The provider of the Prisma schema's datasource: `"postgres"` (`postgresql`) or `"sqlite"`. */
  dialect: "postgres" | "sqlite";
  /**
   * The two tables' names, defaults `cloudrop_files` and `cloudrop_usage`, and on Postgres their schema; letters,
   * digits and `_`.
   */
  tables?: StoreTables;
}

export interface PrismaStoreOptions extends StoreOptionsBase {
  /** Off: each `/complete` holds its file with a lease while `onComplete` runs, and `onComplete` gets no `tx`. */
  transaction?: false;
}

export interface PrismaTransactionalStoreOptions extends StoreOptionsBase {
  dialect: "postgres";
  /**
   * Runs each completion's claim, `onComplete` and completion in one Prisma interactive transaction, and passes its
   * client to `onComplete` as `tx`: what `onComplete` writes through `tx` commits with the completion or not at all.
   */
  transaction: true;
  /** Raise `timeout` when `onComplete` may take longer than Prisma's 5 seconds. */
  transactionOptions?: PrismaTransactionOptions;
}

/** The executor's statements on the client or a transaction's client, in order when batched. */
const on = (client: PrismaQueryable, dialect: "postgres" | "sqlite") =>
  sequential(
    dialect,
    // Prisma answers the rows of a raw query as plain objects, and an empty array for a statement without RETURNING.
    async (sql, params) => (await client.$queryRawUnsafe(sql, ...params)) as SqlRow[],
  );

function checkOptions(options: PrismaStoreOptions | PrismaTransactionalStoreOptions): void {
  const { dialect, transaction } = options;
  if (dialect !== "postgres" && dialect !== "sqlite") {
    throw configError(
      `prismaStore() got dialect ${JSON.stringify(dialect)}. Pass { dialect: "postgres" } or { dialect: "sqlite" }, matching your Prisma datasource.`,
    );
  }
  if (!transaction && "transactionOptions" in options && options.transactionOptions) {
    throw configError(
      "prismaStore(): transactionOptions applies only with transaction: true. Add transaction: true, or remove transactionOptions.",
    );
  }
}

function prismaExecutor(
  prisma: PrismaClientLike,
  { dialect, transactionOptions }: { dialect: "postgres" | "sqlite"; transactionOptions?: PrismaTransactionOptions },
): TransactionalSqlExecutor<PrismaQueryable> {
  return {
    ...on(prisma, dialect),
    // The array form: Prisma runs the queries in order in one transaction, and a failure rolls back all of them.
    batch: async (statements) =>
      (await prisma.$transaction(
        statements.map(({ sql, params }) => prisma.$queryRawUnsafe(sql, ...params)),
      )) as SqlRow[][],
    // The store uses it only with transaction: true, which the core refuses on SQLite.
    transaction: (run) => prisma.$transaction((tx) => run(on(tx, dialect), tx), transactionOptions),
  };
}

/**
 * A cloudrop store over a Prisma 7 client, in two tables you add to your Prisma schema (the store guide links the
 * models). Without `transaction`, a `/complete` holds its file with a lease while `onComplete` runs. With
 * `transaction: true` (Postgres only), the claim, `onComplete` and the completion share one interactive transaction:
 * build routes with `store.route` so `onComplete` gets Prisma's transaction client as `tx`, and keep network calls out
 * of it (they belong in `afterComplete`).
 *
 * On Postgres, tables outside `public` take `tables: { schema: "app" }`, with both models declared `@@schema("app")`
 * and `schemas = ["public", "app"]` in the datasource; every model then needs its `@@schema`. PrismaPg's `schema`
 * option does not reach the store, whose raw SQL uses only `tables`. Without `tables.schema` the store's SQL finds its
 * tables through the connection's search path, set once for the role with `ALTER ROLE <user> SET search_path = app`
 * (this also works behind a connection pooler) or per connection with `?options=-c%20search_path%3Dapp` in the
 * connection string (some poolers drop or refuse that startup option).
 *
 * Usage
 * ```ts
 * const store = prismaStore(prisma, { dialect: "postgres", transaction: true });
 * const avatar = store.route(
 *   { accept: "image/*", maxSize: "5MB", authorize: async ({ request }) => ({ userId: await userIdOf(request) }) },
 *   {
 *     owner: ({ userId }) => userId,
 *     onComplete: async ({ tx, userId, file }) => {
 *       await tx.avatar.create({ data: { userId, key: file.key } });
 *       return { key: file.key };
 *     },
 *   },
 * );
 * export const cloudrop = createCloudrop({ storage: r2(), store, routes: { avatar } });
 * ```
 */
export function prismaStore<TClient extends PrismaClientLike>(
  prisma: TClient,
  options: PrismaTransactionalStoreOptions,
): TransactionalStore<PrismaTransactionClient<TClient>>;
export function prismaStore(prisma: PrismaClientLike, options: PrismaStoreOptions): CloudropStore;
export function prismaStore(
  prisma: PrismaClientLike,
  options: PrismaStoreOptions | PrismaTransactionalStoreOptions,
): CloudropStore<unknown> {
  checkOptions(options);
  const { tables, transaction = false } = options;
  const transactionOptions = options.transaction ? options.transactionOptions : undefined;
  const store = sqlStore(prismaExecutor(prisma, { dialect: options.dialect, transactionOptions }), {
    tables,
    transaction,
  });
  return transaction ? withRoute(store) : store;
}
