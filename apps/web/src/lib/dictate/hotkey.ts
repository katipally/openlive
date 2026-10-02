// Dictate's key, between ol-input's binding grammar ("shift+option_right") and
// what a person reads ("⇧ Right ⌥") or presses in Settings.

const MODIFIERS = { ctrl: ["⌃", "Ctrl"], option: ["⌥", "Alt"], shift: ["⇧", "Shift"], command: ["⌘", "Win"] } as const;
type Modifier = keyof typeof MODIFIERS;
const isModifier = (m: string): m is Modifier => m in MODIFIERS;

/** Each part of `binding` as a keycap: "Right ⌥" on macOS, "Right Alt" elsewhere. */
export function hotkeyKeys(binding: string, platform: string): string[] {
  const mac = platform === "darwin";
  return binding.split("+").map((part) => {
    const [name = "", side] = part.split("_");
    if (!isModifier(name)) return name === "capslock" ? "Caps Lock" : name.toUpperCase();
    const word = name === "command" && platform === "linux" ? "Super" : MODIFIERS[name][mac ? 0 : 1];
    return side === "right" ? `Right ${word}` : side === "left" ? `Left ${word}` : word;
  });
}

const CODES: Record<string, string> = {
  ControlLeft: "ctrl_left", ControlRight: "ctrl_right", AltLeft: "option_left", AltRight: "option_right",
  ShiftLeft: "shift_left", ShiftRight: "shift_right", MetaLeft: "command_left", MetaRight: "command_right",
};
const ORDER = ["ctrl", "option", "shift", "command"];

/**
 * The binding for the keys held down together (KeyboardEvent.code values), or
 * null for a key that would also type into the app in front: Dictate never
 * swallows its key, so only modifiers, Caps Lock and F13 to F24 qualify.
 */
export function bindingOf(codes: Iterable<string>): string | null {
  const mods: string[] = [];
  let key = "";
  for (const code of codes) {
    if (CODES[code]) mods.push(CODES[code]!);
    else if (code === "CapsLock" || /^F(1[3-9]|2[0-4])$/.test(code)) {
      if (key) return null;
      key = code.toLowerCase();
    } else return null;
  }
  if (!mods.length && !key) return null;
  mods.sort((a, b) => ORDER.indexOf(a.split("_")[0]!) - ORDER.indexOf(b.split("_")[0]!));
  return [...mods, ...(key ? [key] : [])].join("+");
}

/** Right Alt types characters as AltGr on many Windows and Linux layouts. */
export const mayBeAltGr = (binding: string, platform: string) => platform !== "darwin" && binding.split("+").includes("option_right");
