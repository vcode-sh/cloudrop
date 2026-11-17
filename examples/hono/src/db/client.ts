// The database, created by each composition root: an explicit node-postgres Pool under Drizzle, as in app-a. The
// caller ends the pool (`db.$client.end()`) when it shuts down.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { relations } from "./relations";

export function createDatabase(url: string) {
  return drizzle({ client: new Pool({ connectionString: url }), relations });
}

export type Database = ReturnType<typeof createDatabase>;
