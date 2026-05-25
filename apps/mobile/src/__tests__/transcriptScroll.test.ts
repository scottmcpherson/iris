import { describe, expect, it } from "vitest";
import {
  TRANSCRIPT_BOTTOM_THRESHOLD,
  distanceFromTranscriptBottom,
  isTranscriptAtBottom,
} from "../chat/transcriptScroll";

describe("transcript scroll helpers", () => {
  it("clamps overscroll and short content to the bottom", () => {
    expect(distanceFromTranscriptBottom({ contentHeight: 300, layoutHeight: 500, offsetY: 0 })).toBe(0);
    expect(distanceFromTranscriptBottom({ contentHeight: 500, layoutHeight: 300, offsetY: 220 })).toBe(0);
  });

  it("treats small residual scroll gaps as bottom", () => {
    expect(
      isTranscriptAtBottom({
        contentHeight: 1_000,
        layoutHeight: 600,
        offsetY: 400 - TRANSCRIPT_BOTTOM_THRESHOLD + 1,
      }),
    ).toBe(true);
  });

  it("reports away from bottom when the gap exceeds the threshold", () => {
    expect(
      isTranscriptAtBottom({
        contentHeight: 1_000,
        layoutHeight: 600,
        offsetY: 400 - TRANSCRIPT_BOTTOM_THRESHOLD - 1,
      }),
    ).toBe(false);
  });
});
