// The store's part of erasing an owner (M12-O1): the durable erase mark on the owner's usage row, kept beside the
// counters so `reserve` reads both under one row lock, and the four methods that set, finish, clear and page it.

/** An owner's erase mark: when `eraseOwner` first asked, and when an erasure finished, null until then. */
export interface OwnerErasure {
  requestedAt: Date;
  erasedAt: Date | null;
}

/** An owner's counters, kept for every row with an owner whether or not a quota is set, and their erase mark. */
export interface OwnerUsage {
  /** Bytes of the owner's `pending` and `completing` rows. */
  reservedBytes: number;
  /** Bytes of the owner's `completed` rows. */
  activeBytes: number;
  /** The owner's `completed` rows (a `deleted` row no longer counts). */
  files: number;
  /** The owner's erase mark, or null when the owner is not being erased (never was, or was reopened). */
  erasure: OwnerErasure | null;
}

/** What `reserve` answers for each file: reserved, refused by the quota, or refused because the owner is erased. */
export type ReserveOutcome = "reserved" | "over-quota" | "erased";

/**
 * The erase mark's methods. The mark lives in two columns of the usage row, `erase_requested_at` and `erased_at`; no
 * method here writes the counters, and no other method writes the mark.
 */
export interface StoreErasure {
  /**
   * Sets the owner's erase mark: `erase_requested_at = now` on the owner's usage row, created with zero counters when
   * there is none, unless the row already has a mark, which is kept as it is. Answers the mark as it is after the
   * call: the first `requestedAt`, and `erasedAt` (null until `erased`). On Postgres it takes the usage row's lock, so
   * it waits for a `reserve` of the owner that holds it, and every `reserve` after it answers `"erased"`.
   */
  markErasure(input: { owner: string; now: Date }): Promise<OwnerErasure>;
  /**
   * Finishes an erasure: `erased_at = now` on the owner's usage row when its `erase_requested_at` is exactly
   * `requestedAt` and `erased_at` is null. True when the mark is `requestedAt` and finished after the call, by this call
   * or an earlier one (whose `erased_at` is kept), so two runs at once both answer done. False, and nothing written,
   * when the mark is another one (the owner was reopened, and maybe marked again) or there is none.
   */
  erased(input: { owner: string; requestedAt: Date; now: Date }): Promise<boolean>;
  /**
   * Clears the owner's erase mark, both columns, so `reserve` reserves for the owner again; the counters stay. True
   * when there was a mark; false, and nothing written, when there was none.
   */
  reopen(input: { owner: string; now: Date }): Promise<boolean>;
  /**
   * One page of the owners whose erasure is unfinished (`erase_requested_at` set, `erased_at` null), in byte order of
   * owner, at most `limit`; `cursor` continues after the previous page's last owner (keyset) and is null on the last
   * page.
   */
  erasing(input: { cursor: string | null; limit: number }): Promise<{ owners: string[]; cursor: string | null }>;
}
