// Coordinates a one-off "snappy" keyboard collapse for deliberate dismissals
// (e.g. the sidebar toggle) without affecting normal keyboard dismissals, which
// should keep following the system keyboard slide.

const FAST_HIDE_MS = 150;
const FAST_WINDOW_MS = 400;

let fastDismissUntil = 0;

/** Request that the next keyboard-hide collapse quickly instead of trailing the
 * system keyboard slide. Call this right before `Keyboard.dismiss()`. */
export function requestFastKeyboardDismiss() {
  fastDismissUntil = Date.now() + FAST_WINDOW_MS;
}

/** Duration the composer/content should use to collapse on keyboard hide.
 * Returns the snappy duration when a fast dismiss was just requested, otherwise
 * follows the system keyboard's animation duration. */
export function keyboardHideDuration(eventDuration?: number) {
  // Don't clear the window here: both the screen and the composer read this for
  // the same hide event and must agree. The short window expires on its own.
  if (Date.now() < fastDismissUntil) return FAST_HIDE_MS;
  return eventDuration || 220;
}
