// One holder at a time sends an upload (spec §3.5, rulings M3-U69, M3-U73, M3-U88): a Web Lock per upload id, held for
// as long as this page keeps the upload's ticket alive, not for one run (audit C2). Persistence needs it: no record is
// saved or resumed without the lock.

export interface UploadLock {
  /**
   * true once this page holds the lock; false when another holder has it, this page included; undefined when the
   * browser refuses Web Locks here (no navigator.locks, a document no longer active, an opaque origin).
   */
  readonly taken: Promise<boolean | undefined>;
  /** Lets the lock go. Called before the answer, it lets the lock go as soon as it is granted; again, it does nothing. */
  release(): void;
}

/** Asks for the Web Lock of upload `id` without waiting (M3-U73). */
export function lockUpload(id: string): UploadLock {
  let release!: () => void;
  const until = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locks = globalThis.navigator?.locks;
  const taken = new Promise<boolean | undefined>((resolve) => {
    if (!locks) return resolve(undefined);
    locks
      .request(`cloudrop:upload:${id}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock && until;
      })
      .catch(() => resolve(undefined));
  });
  return { taken, release };
}
