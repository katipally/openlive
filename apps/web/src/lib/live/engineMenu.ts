// What the Voice settings say about engines, languages and licenses: the pure
// half of the Language picker, the Model menus and the switch notice.

import type { LanguageCode } from "@openlive/shared";
import { CURATED_LANGUAGES, variantInfo, type EngineChange, type Stage } from "./pipelineConfig";

const LANGUAGE = new Map<string, (typeof CURATED_LANGUAGES)[number]>(CURATED_LANGUAGES.map((l) => [l.code, l]));

/** "English", or a language in its own name with the English one after: "Español (Spanish)". */
export function languageLabel(code: LanguageCode): string {
  const l = LANGUAGE.get(code)!;
  // "Chinese (Mandarin)" reads "中文 (Chinese, Mandarin)", not nested brackets.
  return l.native === l.name ? l.name : `${l.native} (${l.name.replace(/ \((.+)\)$/, ", $1")})`;
}

/** Which curated languages `langs` covers, for a greyed-out engine:
 *  "English only", "English, Spanish, French, German", "All 10 languages". */
export function languagesNote(langs: readonly string[]): string {
  const known = CURATED_LANGUAGES.filter((l) => langs.includes(l.code));
  if (known.length === CURATED_LANGUAGES.length) return `All ${known.length} languages`;
  if (known.length === 1) return `${known[0]!.name} only`;
  return known.map((l) => l.name).join(", ");
}

/** A license as a tag, flagging the ones that restrict use or cannot be checked. */
export function licenseTag(license: string): { label: string; kind: "open" | "restricted" | "unknown" } {
  if (/non-commercial|-NC-/i.test(license)) return { label: "Non-commercial", kind: "restricted" };
  if (/AGPL/i.test(license)) return { label: "AGPLv3", kind: "restricted" };
  if (/unknown|^see /i.test(license)) return { label: "Unknown license", kind: "unknown" };
  return { label: license, kind: "open" };
}

/** A family's variants for its Model menu: grouped by language when each
 *  speaks one and they span several (Piper), `lang` first, then the curated
 *  order; else one unlabeled group. O(languages · variants). */
export function variantGroups<V extends { languages: readonly string[] }>(variants: readonly V[], lang: LanguageCode): { lang?: LanguageCode; variants: V[] }[] {
  const flat = [{ variants: [...variants] }];
  if (!variants.every((v) => v.languages.length === 1)) return flat;
  const order = [lang, ...CURATED_LANGUAGES.map((l) => l.code).filter((c) => c !== lang)];
  const groups = order.map((code) => ({ lang: code, variants: variants.filter((v) => v.languages[0] === code) })).filter((g) => g.variants.length);
  return groups.length > 1 ? groups : flat;
}

export interface CatalogVoice { id: string; name: string; lang?: string; gender?: "female" | "male" }
export interface MenuVoice { id: string; name: string; group: string; gender?: "Female" | "Male" }

/** The agent-listed voices that speak `lang` (a voice with no language speaks
 *  any), grouped by accent where the id carries one (Kokoro's "af_", "bm_"),
 *  else by language. O(voices). */
export function voiceMenu(voices: readonly CatalogVoice[], lang: LanguageCode): MenuVoice[] {
  return voices.filter((v) => !v.lang || v.lang === lang).map((v) => ({
    id: v.id,
    name: v.name,
    group: v.lang === "en" && /^[ab][fm]_/.test(v.id) ? (v.id[0] === "a" ? "American" : "British") : LANGUAGE.get(v.lang ?? "")?.name ?? "Voices",
    gender: v.gender === "female" ? "Female" : v.gender === "male" ? "Male" : undefined,
  }));
}

/** A variant's display name: the agent's, else (the agent unreachable) its
 *  family's, plus the id's own part when the family has several: "Piper zh_CN-chaowen-medium-int8". */
export function engineName(id: string, catalog?: readonly { variants: readonly { id: string; name: string }[] }[]): string {
  const listed = catalog?.flatMap((f) => f.variants).find((v) => v.id === id)?.name;
  const family = variantInfo(id)?.family;
  if (listed || !family) return listed ?? id;
  return family.variants.length > 1 ? `${family.name} ${id.replace(`${family.id}-`, "")}` : family.name;
}

const STAGE_NAME: Record<Stage, string> = { stt: "Speech-to-text", tts: "Text-to-speech" };

/** The notice after a language switch: a line per engine swapped (with the
 *  variant to download when it is not on disk yet) and per stage nothing covers. */
export function switchNotice(lang: LanguageCode, changes: readonly EngineChange[], unsupported: readonly Stage[], name: (id: string) => string): { text: string; download?: string }[] {
  const language = LANGUAGE.get(lang)!.name;
  return [
    ...changes.map((c) => ({
      text: `${STAGE_NAME[c.stage]} switched from ${name(c.from)} to ${name(c.to)} for ${language}.${c.needsDownload ? " It needs a one-time download." : ""}`,
      download: c.needsDownload ? c.to : undefined,
    })),
    ...unsupported.map((s) => ({ text: `No ${STAGE_NAME[s].toLowerCase()} engine speaks ${language} yet.` })),
  ];
}
