// cloudrop/store: what a hand-written database store needs (M12-S2). The adapters' stores need none of it, and
// `cloudrop` keeps exporting the same types, so only a store written by hand imports this entry, for `defineStore`.

export type {
  AbortedRecord,
  ClaimOutcome,
  CloudropStore,
  CompletedRecord,
  CompletingRecord,
  Completion,
  DeletedRecord,
  EndedStatus,
  ExpiredRecord,
  FailedRecord,
  FileRecord,
  FileRecordStatus,
  NewFile,
  OwnerUsage,
  PendingRecord,
  RecordOf,
  RejectedRecord,
  TransactionalStore,
  Transition,
} from "./server/store.ts";
export { defineStore } from "./store/define-store.ts";
