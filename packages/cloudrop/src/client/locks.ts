// One tab at a time sends an upload (spec §3.5, ruling R4): a Web Lock per upload id, held for the whole run.

/**
 * Takes the Web Lock for upload `id` without waiting and holds it until `until` settles. true when taken or when there
 * is no navigator.locks; false when another holder has it (R4).
 */
export function lockUpload(id: string, until: Promise<unknown>): Promise<boolean> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return Promise.resolve(true);
  return new Promise((resolve) => {
    locks
      .request(`cloudrop:upload:${id}`, { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        return lock && until;
      })
      // A failed run rejects request() after releasing the lock, when the answer is long given. A page that may not
      // take locks (a document no longer active, an opaque origin) gets here first and runs as one without them.
      .catch(() => resolve(true));
  });
}
