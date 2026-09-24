// The OpenLive mark at icon size: the orb's body as a flat disc and its crest
// as one white sine. The live orb's threads and glow smear below about 24 px,
// so the favicon, tray icons and the smallest in-app marks draw this instead.

/** The disc's lavender to indigo body, top-left to bottom-right, as [offset, colour]. */
export const SINE_MARK_BODY = [[0, "#a58bff"], [0.5, "#5a66dc"], [1, "#2f3591"]] as const;

/** Below this many px across, a still mark draws the sine mark instead of the orb. */
export const SINE_MARK_BELOW = 24;

/** The sine for an n-px mark, in px: one full period, up on the left and down
 *  on the right. The stroke and the amplitude are whole pixels, so at 16, 18
 *  and 32 px its peaks lie flat along pixel rows instead of smearing across two. */
export function sineMark(n: number) {
  const stroke = Math.max(1, Math.round(n / 8));
  const amp = Math.max(1, Math.round(n * 0.15));
  const x0 = n * 0.14, span = n * 0.72, mid = n / 2, steps = 32;
  const pts = Array.from({ length: steps + 1 }, (_, i) =>
    `${+(x0 + (span * i) / steps).toFixed(3)} ${+(mid - amp * Math.sin((2 * Math.PI * i) / steps)).toFixed(3)}`);
  return { d: `M${pts.join("L")}`, stroke };
}
