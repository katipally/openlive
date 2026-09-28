// Which input moved last, so focus the keyboard caused is told apart from focus
// a script caused (a dialog opening, focus handed back on close). Chromium can
// match :focus-visible on scripted focus, so that alone is not enough.
export type Modality = "keyboard" | "pointer";

/** The modality an input event sets, or null when it leaves it as it was: a
 *  chord (Cmd+K) opens something without making the next focus a keyboard one. */
export function modalityOf(e: { type: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): Modality | null {
  if (e.type === "keydown") return e.metaKey || e.ctrlKey || e.altKey ? null : "keyboard";
  return e.type === "pointerdown" ? "pointer" : null;
}

/** Keyboard focus: the last input was the keyboard and the element shows focus. */
export function isKeyboardFocus(el: Element, last: Modality): boolean {
  if (last !== "keyboard") return false;
  try { return el.matches(":focus-visible"); } catch { return true; }
}

let last: Modality = "pointer";
if (typeof window !== "undefined") {
  const note = (e: Event) => { last = modalityOf(e as KeyboardEvent) ?? last; };
  window.addEventListener("keydown", note, true);
  window.addEventListener("pointerdown", note, true);
}

export const keyboardFocused = (el: Element) => isKeyboardFocus(el, last);
