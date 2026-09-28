// A tab set that swaps a tall panel for a short one would pull a reader who
// scrolled down back up: the browser clamps scrollTop to the shorter page. The
// panel keeps the old height as a floor instead, and lets it go the moment
// dropping it would move nothing: once the reader has scrolled up far enough.

/** Whether a height floor of `extra` px below the content can go without the
 *  scroller clamping, i.e. the view already sits above the extra. Pure. */
export const canRelease = (scrollTop: number, scrollHeight: number, clientHeight: number, extra: number): boolean =>
  scrollTop <= Math.max(0, scrollHeight - clientHeight - extra);

/** The nearest ancestor that scrolls vertically, or null. */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/** Sets the floor: call it BEFORE the swap renders. Any layout read after the
 *  short panel is in (a child's measuring effect) would clamp the scroll first. */
export function holdFloor(box: HTMLElement | null): number {
  const floor = box?.offsetHeight ?? 0;
  if (box) box.style.minHeight = `${floor}px`;
  return floor;
}

/** Keeps the floor `box` got from holdFloor until canRelease. The cleanup only
 *  stops watching: it runs as the next swap commits, after that swap's holdFloor,
 *  and clearing the style there would drop the new floor. */
export function releaseWhenFree(box: HTMLElement, floor: number): () => void {
  const scroller = scrollParent(box);
  const release = () => { box.style.minHeight = ""; scroller?.removeEventListener("scroll", check); };
  const check = () => {
    let natural = 0;
    for (const child of box.children) natural += (child as HTMLElement).offsetHeight;
    const extra = floor - natural;
    if (!scroller || extra <= 0 || canRelease(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight, extra)) release();
  };
  scroller?.addEventListener("scroll", check, { passive: true });
  check();
  return () => scroller?.removeEventListener("scroll", check);
}
