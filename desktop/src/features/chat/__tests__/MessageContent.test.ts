import { describe, expect, it } from "vitest";
import { formatAudioPlaybackTime } from "../components/MessageContent";

describe("formatAudioPlaybackTime", () => {
  it("formats short voice message durations", () => {
    expect(formatAudioPlaybackTime(0)).toBe("0:00");
    expect(formatAudioPlaybackTime(2.9)).toBe("0:02");
    expect(formatAudioPlaybackTime(62)).toBe("1:02");
  });

  it("formats longer audio without producing invalid time", () => {
    expect(formatAudioPlaybackTime(3661)).toBe("1:01:01");
    expect(formatAudioPlaybackTime(Number.NaN)).toBe("0:00");
  });
});
