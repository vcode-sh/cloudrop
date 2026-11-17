// cloudrop/adapters/prisma: the database store over a Prisma 7 client, on Postgres or SQLite (spec M5 §7, M5-T14). The
// SQL core writes every statement; this file runs them through `$queryRawUnsafe` and `$transaction`. The client is
// described by the members called here, so the library imports nothing from Prisma.

import { configError } from "../errors.ts";
import { type RouteFunction, routeFor } from "../server/route.ts";
import type { CloudropStore } from "../server/store.ts";
import type { SqlDialect, SqlExecutor, SqlRow, SqlStatement } from "../store/sql/executor.ts";
import { sqlStore } from "../store/sql/store.ts";
import type { StoreTables } from "../store/sql/tables.ts";

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
  $transaction(queries: PromiseLike<unknown>[]): PromiseLike<unknown[]>;
  $transaction<T>(run: (tx: PrismaQueryable) => Promise<T>, options?: PrismaTransactionOptions): PromiseLike<T>;
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
  dialect: SqlDialect;
  /** The two tables' names, defaults `cloudrop_files` and `cloudrop_usage`; letters, digits and `_`. */
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

/** A store with transactions, and `route` for the routes whose `onComplete` receives the transaction as `tx`. */
export interface PrismaTransactionalStore<TTx> extends CloudropStore<TTx> {
  transaction: NonNullable<CloudropStore<TTx>["transaction"]>;
  /** `route()`, with `onComplete({ tx })` typed as Prisma's transaction client. Use it with this store only. */
  route: RouteFunction<{ tx: TTx }>;
}

const rowsOf = async (client: PrismaQueryable, { sql, params }: SqlStatement): Promise<SqlRow[]> =>
  // Prisma answers the rows of a raw query as plain objects, and an empty array for a statement without RETURNING.
  (await client.$queryRawUnsafe(sql, ...params)) as SqlRow[];

async function inOrder(client: PrismaQueryable, statements: readonly SqlStatement[]): Promise<SqlRow[][]> {
  const results: SqlRow[][] = [];
  for (const statement of statements) results.push(await rowsOf(client, statement));
  return results;
}

function checkOptions(options: PrismaStoreOptions | PrismaTransactionalStoreOptions): void {
  const { dialect, transaction } = options;
  if (dialect !== "postgres" && dialect !== "sqlite") {
    throw configError(
      `prismaStore() got dialect ${JSON.stringify(dialect)}. Pass { dialect: "postgres" } or { dialect: "sqlite" }, matching your Prisma datasource.`,
    );
  }
  if (transaction && dialect !== "postgres") {
    throw configError(
      "prismaStore({ transaction: true }) needs Postgres. SQLite has one writer at a time, so a transaction held open while onComplete runs would stall every other upload; leave transaction off on SQLite.",
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
  options: PrismaStoreOptions | PrismaTransactionalStoreOptions,
): SqlExecutor<PrismaQueryable> {
  const { dialect } = options;
  const executor: SqlExecutor<PrismaQueryable> = {
    dialect,
    query: (sql, params) => rowsOf(prisma, { sql, params }),
    // The array form: Prisma runs the queries in order in one transaction, and a failure rolls back all of them.
    batch: async (statements) =>
      (await prisma.$transaction(
        statements.map(({ sql, params }) => prisma.$queryRawUnsafe(sql, ...params)),
      )) as SqlRow[][],
  };
  if (!options.transaction) return executor;
  return {
    ...executor,
    transaction: async (run) =>
      prisma.$transaction(
        (tx) =>
          run(
            {
              dialect,
              query: (sql, params) => rowsOf(tx, { sql, params }),
              // Already inside the transaction, whose client has no $transaction of its own.
              batch: (statements) => inOrder(tx, statements),
            },
            tx,
          ),
        options.transactionOptions,
      ),
  };
}

/**
 * A cloudrop store over a Prisma 7 client, in two tables you add to your Prisma schema (the models are in the store
 * guide). Without `transaction`, a `/complete` holds its file with a lease while `onComplete` runs. With
 * `transaction: true` (Postgres only), the claim, `onComplete` and the completion share one interactive transaction:
 * build routes with `store.route` so `onComplete` gets Prisma's transaction client as `tx`, and keep network calls out
 * of it (they belong in `afterComplete`).
 *
 * On Postgres the store's SQL finds its tables through the connection's search path, not PrismaPg's `schema` option,
 * which only model queries use. Tables outside `public` need both, for example `?options=-c%20search_path%3Dapp` in the
 * connection string beside `new PrismaPg({ connectionString }, { schema: "app" })`.
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
): PrismaTransactionalStore<PrismaTransactionClient<TClient>>;
export function prismaStore(prisma: PrismaClientLike, options: PrismaStoreOptions): CloudropStore;
export function prismaStore(
  prisma: PrismaClientLike,
  options: PrismaStoreOptions | PrismaTransactionalStoreOptions,
): CloudropStore<unknown> {
  checkOptions(options);
  const store = sqlStore(prismaExecutor(prisma, options), { tables: options.tables });
  // routeFor brands routes with this very object, the one the app passes to createCloudrop.
  return options.transaction ? Object.assign(store, { route: routeFor<{ tx: unknown }>(store) }) : store;
}
