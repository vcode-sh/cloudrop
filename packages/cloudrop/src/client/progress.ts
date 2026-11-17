// How much of a file has been sent (spec §4.2) and how fast (spec §4.3).

/** The speed's time constant: the average follows a change in rate within about 3 s. */
const TIME_CONSTANT_MS = 3000;

export interface Progress {
  /** Bytes counted for the file: the sum over its parts of the most each attempt ever sent. Never decreases. */
  readonly bytes: number;
  /** The current attempt of `part` has sent `sent` of `partSize` bytes. Returns what this added to `bytes`. */
  sent(part: number, sent: number, partSize: number): number;
}

export function createProgress(): Progress {
  const best = new Map<number, number>();
  let bytes = 0;
  return {
    get bytes() {
      return bytes;
    },
    sent(part, sent, partSize) {
      const before = best.get(part) ?? 0;
      const reached = Math.min(sent, partSize);
      // A re-sent attempt adds nothing until it passes what an earlier attempt of the same part reached.
      if (reached <= before) return 0;
      best.set(part, reached);
      bytes += reached - before;
      return reached - before;
    },
  };
}

export interface Meter {
  /** `bytes` more were sent by `now` (ms). */
  add(bytes: number, now: number): void;
  /** Bytes per second at `now`, decayed since the last add. */
  speed(now: number): number;
  /** Starts from 0 at `now`: when a file starts or resumes sending. */
  restart(now: number): void;
}

/** A meter at rest: restart() starts it when the file starts sending. */
export function createMeter(): Meter {
  let rate = 0;
  let last = 0;
  // Bytes reported in the same millisecond as `last`: no time has passed to divide them by.
  let pending = 0;
  return {
    add(bytes, at) {
      const elapsed = at - last;
      if (elapsed <= 0) {
        pending += bytes;
        return;
      }
      const alpha = 1 - Math.exp(-elapsed / TIME_CONSTANT_MS);
      rate += alpha * (((bytes + pending) * 1000) / elapsed - rate);
      pending = 0;
      last = at;
    },
    speed: (at) => rate * Math.exp(-Math.max(0, at - last) / TIME_CONSTANT_MS),
    restart(at) {
      rate = 0;
      last = at;
      pending = 0;
    },
  };
}
