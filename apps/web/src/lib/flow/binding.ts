import { desktopPlatform } from "@/lib/platform";

// The addon's binding vocabulary, on both sides of the capture field: a browser
// KeyboardEvent becomes the `+`-joined canonical string the addon parses, and
// that string becomes the keycap the person reads. The addon stays the authority
// on whether a binding is valid; this only speaks its language.

const MAC = () => desktopPlatform === "darwin" || (!desktopPlatform && typeof navigator !== "undefined" && /Mac/i.test(navigator.platform));

/** `KeyboardEvent.code` for the modifiers, in the order the addon formats them. */
const MODIFIER_CODES: Record<string, string> = {
  ControlLeft: "ctrl_left", ControlRight: "ctrl_right",
  AltLeft: "option_left", AltRight: "option_right",
  ShiftLeft: "shift_left", ShiftRight: "shift_right",
  MetaLeft: "command_left", MetaRight: "command_right",
};
const GROUP_ORDER = ["ctrl", "option", "shift", "command", "fn"];

/** How each group is written on a keycap, per platform. */
const GROUP_LABEL: Record<string, { mac: string; other: string }> = {
  ctrl: { mac: "Control", other: "Ctrl" },
  option: { mac: "Option", other: "Alt" },
  shift: { mac: "Shift", other: "Shift" },
  command: { mac: "Command", other: "Win" },
  fn: { mac: "Fn", other: "Fn" },
};

/** A `KeyboardEvent.code` for a non-modifier key, as the addon names it. */
export function keyName(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return `num${code.slice(5)}`;
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  const named: Record<string, string> = {
    Space: "space", Enter: "return", Tab: "tab", Backspace: "delete", Escape: "escape",
    ArrowLeft: "leftarrow", ArrowRight: "rightarrow", ArrowUp: "uparrow", ArrowDown: "downarrow",
    Backquote: "grave", Minus: "minus", Equal: "equal", Slash: "slash", Backslash: "backslash",
    Semicolon: "semicolon", Quote: "quote", Comma: "comma", Period: "period",
    BracketLeft: "leftbracket", BracketRight: "rightbracket",
  };
  return named[code] ?? "";
}

/** The binding a key event describes, or "" when it describes nothing usable.
 *  Modifier-only is first class: one held modifier IS a binding. */
export function bindingFromEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  const held = new Set<string>();
  const side = MODIFIER_CODES[e.code];
  if (side) held.add(side);
  // The event's own flags fill in the modifiers already down, which is what makes
  // "hold Control, then press Shift" read as ctrl+shift rather than as shift alone.
  if (e.ctrlKey && !held.has("ctrl_right")) held.add("ctrl_left");
  if (e.altKey && !held.has("option_right")) held.add("option_left");
  if (e.shiftKey && !held.has("shift_right")) held.add("shift_left");
  if (e.metaKey && !held.has("command_right")) held.add("command_left");
  if (side) held.delete(sideless(side));

  const parts = GROUP_ORDER.flatMap((g) => [...held].filter((h) => h.startsWith(`${g}_`)).slice(0, 1));
  const key = side ? "" : keyName(e.code);
  if (!parts.length && !key) return "";
  return [...parts, key].filter(Boolean).join("+");
}

/** The opposite side of the same group, so a right modifier never also reports left. */
const sideless = (name: string) => `${name.split("_")[0]}_${name.endsWith("_right") ? "left" : "right"}`;

/** The binding, written the way it is printed on the keyboard. */
export function bindingLabel(binding: string): string {
  if (!binding.trim()) return "Not set";
  const mac = MAC();
  return binding
    .split("+")
    .map((part) => {
      const [group, sideName] = part.split("_");
      const label = GROUP_LABEL[group ?? ""];
      if (!label) return part.length === 1 ? part.toUpperCase() : titleCase(part);
      const side = sideName === "left" ? "Left " : sideName === "right" ? "Right " : "";
      return `${side}${mac ? label.mac : label.other}`;
    })
    .join(" + ");
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** True while the person is still only holding modifiers, so the field can say
 *  "let go to save it, or press another key to combine". */
export const isModifierOnly = (binding: string): boolean =>
  !!binding && binding.split("+").every((p) => GROUP_ORDER.includes(p.split("_")[0] ?? ""));
