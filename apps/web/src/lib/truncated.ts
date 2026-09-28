type Box = Pick<Element, "scrollWidth" | "clientWidth" | "scrollHeight" | "clientHeight">;

/** Whether text is cut off: an ellipsis (wider than its box) or a line clamp (taller). */
export const isTruncated = (el: Box) => el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
