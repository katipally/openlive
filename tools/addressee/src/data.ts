import { readFileSync } from "node:fs";

// The synthetic set (data/*.json, written for the eval): a training split of
// English sentences in context, and held-out English and nine-language splits.
type Raw = [label: "to" | "side", speaker: string, reply: string, said: string, tag: string];
export interface Row { split: "train" | "en" | "multi"; lang: string; side: boolean; speaker: string; reply: string; said: string; tag: string }
const data = (f: string) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const rows = (split: Row["split"], lang: string, raw: Raw[]): Row[] =>
  raw.map(([l, speaker, reply, said, tag]) => ({ split, lang, side: l === "side", speaker, reply, said, tag }));

export const synthetic = (): Row[] => [
  ...rows("train", "en", data("train.en.json").rows),
  ...rows("en", "en", data("test.en.json").rows),
  ...Object.entries(data("test.multi.json").langs as Record<string, Raw[]>).flatMap(([lang, r]) => rows("multi", lang, r)),
];
