import { describe, expect, it } from "vitest";
import {
  amplitudeFromTimeDomainData,
  formatDictationElapsed,
} from "../useVoiceDictation";

describe("voice recording helpers", () => {
  it("formats elapsed recording time", () => {
    expect(formatDictationElapsed(4_200)).toBe("0:04");
    expect(formatDictationElapsed(37_900)).toBe("0:37");
    expect(formatDictationElapsed(72_100)).toBe("1:12");
  });

  it("reports no amplitude for an empty buffer", () => {
    expect(amplitudeFromTimeDomainData(new Uint8Array())).toBe(0);
  });

  it("reports silence at the baseline for a flat (centered) waveform", () => {
    const silent = new Uint8Array([128, 128, 128, 128, 128, 128, 128, 128]);
    expect(amplitudeFromTimeDomainData(silent)).toBe(0);
  });

  it("scales the amplitude with how loud the samples deviate from center", () => {
    const quiet = new Uint8Array([128, 140, 128, 118, 128, 138, 128, 120]);
    const loud = new Uint8Array([128, 220, 128, 30, 128, 210, 128, 40]);
    const quietLevel = amplitudeFromTimeDomainData(quiet);
    const loudLevel = amplitudeFromTimeDomainData(loud);
    expect(quietLevel).toBeGreaterThan(0);
    expect(loudLevel).toBeGreaterThan(quietLevel);
    expect(loudLevel).toBeLessThanOrEqual(1);
  });
});
