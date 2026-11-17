import { defineConfig } from "drizzle-kit";

// `bun run db:generate` writes a migration from src/db/schema; `bun run db:migrate` applies the pending ones. Bun
// loads DATABASE_URL from .env (scripts/setup-rustfs.ts writes it).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
