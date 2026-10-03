import type { FlowConfig } from "@openlive/flow-store";
import { narrowToggle, pttKeyOk, sameKey, toggleKeyOk } from "@openlive/flow-store/shared";

// The talk keys (Flow's, Dictate's and push to talk's), between ol-input's
// binding grammar ("option_right") and what a person reads ("Right ⌥", "Right
// Option") or presses in Settings.

/** Symbol on a Mac, word on a Mac, word elsewhere. */
const MODIFIERS = { ctrl: ["⌃", "Control", "Ctrl"], option: ["⌥", "Option", "Alt"], shift: ["⇧", "Shift", "Shift"], command: ["⌘", "Command", "Win"] } as const;
type Modifier = keyof typeof MODIFIERS;
const isModifier = (m: string): m is Modifier => m in MODIFIERS;

function names(binding: string, platform: string, words: boolean): string[] {
  const mac = platform === "darwin";
  return binding.split("+").map((part) => {
    const [name = "", side] = part.split("_");
    if (!isModifier(name)) return name === "fn" ? "Fn" : name.toUpperCase();
    const word = name === "command" && platform === "linux" ? "Super" : MODIFIERS[name][mac ? (words ? 1 : 0) : 2];
    return side === "right" ? `Right ${word}` : side === "left" ? `Left ${word}` : word;
  });
}

/** Each part of `binding` as a keycap: "Right ⌥" on macOS, "Right Alt" elsewhere. */
export const hotkeyKeys = (binding: string, platform: string): string[] => names(binding, platform, false);

/** `binding` in words, for a sentence: "Right Option" on macOS, "Right Alt" elsewhere. */
export const keyName = (binding: string, platform: string): string => names(binding, platform, true).join(" + ");

const CODES: Record<string, string> = {
  ControlLeft: "ctrl_left", ControlRight: "ctrl_right", AltLeft: "option_left", AltRight: "option_right",
  ShiftLeft: "shift_left", ShiftRight: "shift_right", MetaLeft: "command_left", MetaRight: "command_right",
};
const ORDER = ["ctrl", "option", "shift", "command"];

/**
 * The binding for the keys held down together (KeyboardEvent.code values), or
 * null for a key that would also type into the app in front: the talk keys are
 * never swallowed, so only modifiers, Fn and F13 to F24 qualify.
 */
export function bindingOf(codes: Iterable<string>): string | null {
  const mods: string[] = [];
  let key = "";
  for (const code of codes) {
    if (CODES[code]) mods.push(CODES[code]!);
    else if (code === "Fn" || /^F(1[3-9]|2[0-4])$/.test(code)) {
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

export type Talk = FlowConfig["talk"];
export type TalkKey = "flowKey" | "dictateKey" | "pttKey";
export const KEY_OWNER: Record<TalkKey, string> = { flowKey: "Flow", dictateKey: "Dictate", pttKey: "Push to talk" };

/** A "Close after silence" wait as its picker names it: "30 sec", "5 min". */
export const silenceLabel = (ms: number): string => (ms < 120_000 ? `${Math.round(ms / 1000)} sec` : `${Math.round(ms / 60_000)} min`);

/** The keys as the hook watches them now: in push to talk, a double-tap key
 *  gives up the side push to talk holds, as main registers them. */
export function liveKeys(talk: Talk): { flow: string; dictate: string; ptt: string } {
  const narrow = (k: string) => (talk.mode === "ptt" ? narrowToggle(k, talk.pttKey) ?? k : k);
  return { flow: narrow(talk.flowKey), dictate: narrow(talk.dictateKey), ptt: talk.pttKey };
}

/** Why `key` cannot be `role`'s key beside the other two, in words, or null when
 *  it can. A double-tap key never shares a physical key with the other one, and
 *  push to talk never leaves one with no key at all. Checked in either talk
 *  mode, so switching modes can never break a key. */
export function keyIssue(role: TalkKey, key: string, talk: Talk, platform: string): string | null {
  const name = (k: string) => keyName(k, platform);
  if (role === "pttKey") {
    if (!pttKeyOk(key, platform)) {
      if (key === "fn") return "Fn never reaches Windows or Linux. Pick another key.";
      if (/^(ctrl|option|shift|command)$/.test(key)) return `Pick one side, like Right ${name(key)}.`;
      return `Push to talk takes one key that types nothing: one side of ${name("ctrl")}, ${name("option")}, ${name("shift")} or ${name("command")}${platform === "darwin" ? ", Fn" : ""}, or F13 to F24.`;
    }
    for (const toggle of ["flowKey", "dictateKey"] as const) {
      if (narrowToggle(talk[toggle], key) === null) return `${KEY_OWNER[toggle]} opens with ${name(talk[toggle])}, which would leave it no key. Change ${KEY_OWNER[toggle]}'s key first.`;
    }
    return null;
  }
  if (!toggleKeyOk(key, platform)) return `Use one modifier, like ${name("ctrl")} or ${name("option")}, or F13 to F24.`;
  const other: TalkKey = role === "flowKey" ? "dictateKey" : "flowKey";
  if (sameKey(key, talk[other])) return `${KEY_OWNER[other]} opens with ${name(talk[other])}. Pick another key.`;
  if (narrowToggle(key, talk.pttKey) === null) return `Push to talk is ${name(talk.pttKey)}, which would leave ${KEY_OWNER[role]} no key. Pick another.`;
  return null;
}

/** What a capture means for `role`: a modifier double-tapped counts on either
 *  side, unless that clashes and its own side does not. The binding, or why not. */
export function pickKey(role: TalkKey, captured: string | null, talk: Talk, platform: string): { key: string } | { issue: string } {
  if (!captured) return { issue: `That key types, or that was more than one key. Use one modifier, like ${keyName("ctrl", platform)} or ${keyName("option", platform)}, or F13 to F24.` };
  // The very key push to talk holds is refused, rather than quietly widened to the side left over.
  if (role !== "pttKey" && narrowToggle(captured, talk.pttKey) === null) return { issue: keyIssue(role, captured, talk, platform) ?? "" };
  const group = /^(ctrl|option|shift|command)_(left|right)$/.exec(captured)?.[1];
  const tries = role !== "pttKey" && group ? [group, captured] : [captured];
  let issue = "";
  for (const key of tries) {
    const why = keyIssue(role, key, talk, platform);
    if (!why) return { key };
    issue = why;
  }
  return { issue };
}

/** How a double-tap key is narrowed beside push to talk, in words; "" when it is not. */
export function narrowNote(role: "flowKey" | "dictateKey", talk: Talk, platform: string): string {
  const narrowed = narrowToggle(talk[role], talk.pttKey);
  if (!narrowed || narrowed === talk[role]) return "";
  const owner = KEY_OWNER[role];
  return talk.mode === "ptt"
    ? `${owner} uses ${keyName(narrowed, platform)} only, since Push to talk is ${keyName(talk.pttKey, platform)}.`
    : `In Push to talk, ${owner} uses ${keyName(narrowed, platform)} only, since that holds ${keyName(talk.pttKey, platform)}.`;
}
