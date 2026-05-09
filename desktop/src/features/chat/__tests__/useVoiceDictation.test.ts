import { describe, expect, it } from "vitest";
import {
  audioLevelsFromFrequencyData,
  audioLevelsFromTimeDomainData,
  formatDictationElapsed,
} from "../useVoiceDictation";

describe("voice recording helpers", () => {
  it("formats elapsed recording time", () => {
    expect(formatDictationElapsed(4_200)).toBe("0:04");
    expect(formatDictationElapsed(37_900)).toBe("0:37");
    expect(formatDictationElapsed(72_100)).toBe("1:12");
  });

  it("maps microphone time-domain samples into independent waveform bars", () => {
    const silent = new Uint8Array([128, 128, 128, 128]);
    expect(audioLevelsFromTimeDomainData(silent, 4)).toEqual([0, 0, 0, 0]);

    const voiced = new Uint8Array([128, 160, 128, 142, 128, 136, 128, 128]);
    const levels = audioLevelsFromTimeDomainData(voiced, 4);
    expect(levels).toHaveLength(4);
    expect(levels[0]).toBeGreaterThan(levels[2]);
    expect(levels[1]).toBeGreaterThan(0);
    expect(levels[2]).toBeGreaterThan(0);
  });

  it("maps microphone frequency bins into independent waveform bars", () => {
    const silent = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(audioLevelsFromFrequencyData(silent, 4)).toEqual([0, 0, 0, 0]);

    const voiced = new Uint8Array([0, 0, 70, 22, 120, 12, 52, 18, 0, 0, 0, 0]);
    const levels = audioLevelsFromFrequencyData(voiced, 4);
    expect(levels).toHaveLength(4);
    expect(levels.some((level) => level > 0.5)).toBe(true);
    expect(new Set(levels.map((level) => level.toFixed(2))).size).toBeGreaterThan(1);
  });
});
