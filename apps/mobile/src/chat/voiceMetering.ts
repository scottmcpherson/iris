// expo-audio reports recording metering in dBFS (<= 0). Treat anything below the
// floor as silence and map [floor, 0] onto [0, 1] with a gentle curve so quiet
// speech stays visible without the baseline creeping up from room noise.
export const METERING_FLOOR_DB = -55;

export function normalizeMetering(metering: number | undefined | null): number {
  if (metering == null || !Number.isFinite(metering)) return 0;
  const clamped = Math.max(METERING_FLOOR_DB, Math.min(0, metering));
  const linear = (clamped - METERING_FLOOR_DB) / (0 - METERING_FLOOR_DB);
  return Math.min(1, Math.pow(linear, 1.4));
}
