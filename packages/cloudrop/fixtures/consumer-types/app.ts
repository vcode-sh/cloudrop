// The type rows of spec 1.0 §3a (M12-T5, M12-T6), compiled against the packed .d.ts by scripts/check-package.sh. Each
// expect-error directive is an assertion: the build must keep the check, not only the names. Nothing here runs.

import {
  allowAnyone,
  type CloudropPlugin,
  type CloudropStore,
  createCloudrop,
  type DeleteContext,
  route,
} from "cloudrop";
import { contentChecks } from "cloudrop/plugins";

interface FileDeleter {
  adminId: string;
}
declare const store: CloudropStore<unknown>;
const policy = { accept: "*/*", maxSize: 1 } as const;
const signedIn = route({ ...policy, authorize: () => ({ userId: "u1", since: new Date(0) }) });
const open = route({ ...policy, authorize: allowAnyone });
const moderated = route(
  { ...policy, authorize: () => ({ userId: "u1" }) },
  { onDelete: ({ context }: DeleteContext<FileDeleter, undefined>) => void context },
);
const perUser: CloudropPlugin<{ userId: string }> = {
  id: "per-user",
  server: {
    afterVerify: ({ auth }) => {
      const userId: string = auth.userId;
      return userId === "" ? undefined : undefined;
    },
  },
};

export function plugins(): void {
  // @ts-expect-error: `open` authorizes without a userId.
  createCloudrop({ routes: { signedIn, open }, plugins: [perUser] });
  createCloudrop({ routes: { signedIn, moderated }, plugins: [perUser, contentChecks()] });
  createCloudrop({
    routes: { signedIn },
    plugins: [
      {
        id: "inline",
        server: {
          beforeUpload: ({ auth }) => {
            // The token's JSON snapshot: the Date is a string.
            const since: string = auth.since;
            return since === "" ? undefined : undefined;
          },
        },
      },
    ],
  });
}

export function deletions(): void {
  const { api } = createCloudrop({ routes: { moderated, open }, store });
  // @ts-expect-error: moderated's onDelete needs to know who deletes.
  void api.deleteFile("f1");
  void api.deleteFile("f1", { context: { adminId: "a1" } });
  void api.eraseOwner("u1");
  // @ts-expect-error: the erased context is declared undefined.
  void api.eraseOwner("u1", { context: { adminId: "a1" } });
  const plain = createCloudrop({ routes: { open }, store }).api;
  void plain.deleteFile("f1");
  void plain.eraseOwner("u1", { context: 42 });
}
