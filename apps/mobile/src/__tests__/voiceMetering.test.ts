import { describe, expect, it } from "vitest";
import { METERING_FLOOR_DB, normalizeMetering } from "../chat/voiceMetering";

describe("normalizeMetering", () => {
  it("treats missing or non-finite metering as silence", () => {
    expect(normalizeMetering(undefined)).toBe(0);
    expect(normalizeMetering(null)).toBe(0);
    expect(normalizeMetering(Number.NaN)).toBe(0);
    expect(normalizeMetering(-Infinity)).toBe(0);
  });

  it("maps the dBFS floor to 0 and 0 dBFS to 1", () => {
    expect(normalizeMetering(METERING_FLOOR_DB)).toBe(0);
    expect(normalizeMetering(METERING_FLOOR_DB - 20)).toBe(0);
    expect(normalizeMetering(0)).toBe(1);
  });

  it("increases monotonically as the recording gets louder", () => {
    const quiet = normalizeMetering(-40);
    const normal = normalizeMetering(-20);
    const loud = normalizeMetering(-6);
    expect(quiet).toBeGreaterThan(0);
    expect(normal).toBeGreaterThan(quiet);
    expect(loud).toBeGreaterThan(normal);
    expect(loud).toBeLessThanOrEqual(1);
  });
});
