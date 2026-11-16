// One holder at a time sends an upload (spec §3.5, rulings M3-U69, M3-U73): a Web Lock per upload id, held for as long
// as this page keeps the upload's ticket alive, not for one run (audit C2).

export interface UploadLock {
  /** true once this page holds the lock, or where there is no navigator.locks; false when another holder has it. */
  readonly taken: Promise<boolean>;
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
  const taken = new Promise<boolean>((resolve) => {
    if (!locks) return resolve(true);
    locks
      .request(`cloudrop:upload:${id}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock && until;
      })
      // A page that may not take locks (a document no longer active, an opaque origin) runs as one without them.
      .catch(() => resolve(true));
  });
  return { taken, release };
}
