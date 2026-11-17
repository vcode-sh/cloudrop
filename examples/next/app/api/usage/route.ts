import { cloudrop, demoUser } from "../../../lib/cloudrop";
import { quotaBytes, type RecordedUpload, store, uploadsOf } from "../../../lib/store";

/** What the lab shows of the signed-in user's storage: nothing without a store. */
export type UsageInfo =
  | { store: false }
  | {
      store: true;
      reservedBytes: number;
      activeBytes: number;
      files: number;
      quotaBytes: number;
      /** The app's own record of the user's finished uploads, written by onComplete. */
      uploads: RecordedUpload[];
    };

/** The signed-in user's usage from cloudrop.api.usage, with their quota and finished uploads. */
export async function GET(request: Request): Promise<Response> {
  if (!store) return Response.json({ store: false } satisfies UsageInfo);
  const userId = demoUser(request);
  if (!userId) return Response.json({ error: "Sign in as the demo user first." }, { status: 401 });
  const { data, error } = await cloudrop.api.usage(userId);
  // The message says what to do and carries no storage or database detail; the logger has the rest.
  if (error) return Response.json({ error: error.message }, { status: 503 });
  return Response.json({ store: true, ...data, quotaBytes, uploads: uploadsOf(userId) } satisfies UsageInfo);
}
