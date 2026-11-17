// cloudrop's two tables, declared in the app's schema so drizzle-kit generates and migrates them with everything else
// (docs/guide/store.md "Create the tables"). Read them freely; write to them only through the store, which keeps
// `cloudrop_usage` in step with `cloudrop_files`.
import { cloudropPgTables } from "cloudrop/adapters/drizzle";

export const { files: cloudropFiles, usage: cloudropUsage } = cloudropPgTables();
