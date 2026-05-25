export const TRANSCRIPT_BOTTOM_THRESHOLD = 72;
export const TRANSCRIPT_STREAM_SETTLE_DELAYS_MS = [0, 120, 280] as const;
export const TRANSCRIPT_BUTTON_SETTLE_DELAYS_MS = [360, 560] as const;

export function distanceFromTranscriptBottom({
  contentHeight,
  layoutHeight,
  offsetY,
}: {
  contentHeight: number;
  layoutHeight: number;
  offsetY: number;
}) {
  return Math.max(0, contentHeight - layoutHeight - offsetY);
}

export function isTranscriptAtBottom(
  metrics: {
    contentHeight: number;
    layoutHeight: number;
    offsetY: number;
  },
  threshold = TRANSCRIPT_BOTTOM_THRESHOLD,
) {
  return distanceFromTranscriptBottom(metrics) <= threshold;
}
