// Contract: spec §4.2 (a file's bytes never go backwards when a part is re-sent) and §4.3 (speed is an EWMA of bytes
// per second with a 3 s time constant, decaying when no bytes arrive). Oracle: the EWMA worked by hand,
// α = 1 − e^(−Δt/3000).

import { describe, expect, it } from "vitest";
import { createMeter, createProgress } from "./progress.ts";

describe("createProgress", () => {
  it("counts a re-sent part only once it passes the earlier attempt", () => {
    const progress = createProgress();
    const added = [progress.sent(1, 40, 100), progress.sent(1, 10, 100), progress.sent(1, 30, 100)];
    added.push(progress.sent(1, 60, 100));
    expect(added).toEqual([40, 0, 0, 20]);
    expect(progress.bytes).toBe(60);
  });

  it("counts a report above the part size only up to the part size", () => {
    const progress = createProgress();
    expect(progress.sent(1, 150, 100)).toBe(100);
    expect(progress.bytes).toBe(100);
  });

  it("adds up every part of the file", () => {
    const progress = createProgress();
    progress.sent(1, 100, 100);
    progress.sent(2, 50, 50);
    expect(progress.bytes).toBe(150);
  });
});

describe("createMeter", () => {
  it("averages bytes per second and decays while nothing arrives", () => {
    const meter = createMeter();
    meter.restart(0);
    meter.add(1000, 1000);
    expect(meter.speed(1000)).toBeCloseTo(283.4687, 3);
    meter.add(1000, 2000);
    expect(meter.speed(2000)).toBeCloseTo(486.5829, 3);
    // Three seconds without bytes: one time constant, a factor of e^(−1).
    expect(meter.speed(5000)).toBeCloseTo(179.0038, 3);
  });

  it("keeps bytes reported in the same millisecond for the next add", () => {
    const meter = createMeter();
    meter.restart(0);
    meter.add(1000, 0);
    meter.add(2000, 500);
    // 3000 bytes over 500 ms is 6000 B/s, weighted by α = 1 − e^(−1/6).
    expect(meter.speed(500)).toBeCloseTo(921.1097, 3);
  });

  it("starts again from 0 on restart", () => {
    const meter = createMeter();
    meter.add(1000, 1000);
    meter.restart(1000);
    expect(meter.speed(1000)).toBe(0);
    // Measured from the restart, not from the meter's creation: the same oracle as one second from 0.
    meter.add(1000, 2000);
    expect(meter.speed(2000)).toBeCloseTo(283.4687, 3);
  });
});
