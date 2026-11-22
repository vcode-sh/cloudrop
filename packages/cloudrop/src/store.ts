// cloudrop/store: what a hand-written database store needs (M12-S2). The adapters' stores need none of it, and
// `cloudrop` keeps exporting the same types, so only a store written by hand imports this entry, for `defineStore`.

export type {
  ClaimOutcome,
  CloudropStore,
  Completion,
  EndedStatus,
  FileRecord,
  FileStatus,
  NewFile,
  OwnerUsage,
  TransactionalStore,
  Transition,
} from "./server/store.ts";
export { defineStore } from "./store/define-store.ts";
