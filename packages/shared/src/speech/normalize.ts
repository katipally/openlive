// Text as a voice should read it: numbers, dates, times, money, units,
// percentages, ranges, phone numbers, versions, emails, URLs and file names,
// code identifiers, initialisms and symbols spelled out the way a person says
// them, in the session language. Pure and synchronous: it runs once per spoken
// chunk, after markdown is stripped and before any engine's own preprocessing.
// Number words come from n2words (MIT, zero deps); structure (decimal and
// group marks, unit and currency names and their plurals, date order) from Intl.
// Each pass is one linear regex scan, so a chunk of n characters costs O(n) a pass.

import * as en from "n2words/en";
import * as es from "n2words/es";
import * as fr from "n2words/fr";
import * as de from "n2words/de";
import * as it from "n2words/it";
import * as pt from "n2words/pt-BR";
import * as hi from "n2words/hi";
import * as zh from "n2words/zh-Hans-CN";
import * as ja from "n2words/ja";
import * as ko from "n2words/ko";
import type { Lexicon } from "./lexicon";

// pt-BR and zh type their currency option as their own codes; money() checks
// a code against currencyValues before it calls toCurrency.
interface N2W {
  toCardinal(v: string, o?: object): string;
  toOrdinal(v: string, o?: object): string;
  toCurrency(v: string, o: { currency: string }): string;
  currencyValues?: { currency: readonly string[] };
}

/** How one language says what the passes below produce. `one` is "1" before
 *  a noun where it differs from counting ("un kilómetro", "ein Kilometer"). */
interface Lang {
  code: string; locale: string; n: N2W; opts?: object; unspaced?: boolean; one?: string;
  point: string; vsep: string; dot: string; at: string; and: string; plus: string; minus: string; times: string; by: string; fold: string;
  equals: string; to: string; about: string; version: string; dash: string; more?: string; less?: string;
  number(n: string): string; percent(n: string): string; time(h: number, m: number, clock12: boolean): string;
}

const LANGS: Record<string, Lang> = {};
const lang = (code: string) => LANGS[code] ?? LANGS.en!;
const add = (l: Lang) => { LANGS[l.code] = l; };

add({
  code: "en", locale: "en-US", n: en, point: "point", vsep: "point", dot: "dot", at: "at", and: "and", plus: "plus", minus: "minus",
  times: "times", by: "by", fold: "times", equals: "equals", to: "to", about: "about", version: "version", dash: "dash", more: "more than", less: "less than",
  number: (n) => `number ${n}`, percent: (n) => `${n} percent`,
  time(h, m, clock12) {
    const c = (x: number) => card(this, String(x));
    if (m) return `${c(h)} ${m < 10 ? "oh " : ""}${c(m)}`;
    return clock12 ? c(h) : h > 12 ? `${c(h)} hundred` : `${c(h)} o'clock`;
  },
});
add({
  code: "es", locale: "es", n: es, one: "un", point: "coma", vsep: "punto", dot: "punto", at: "arroba", and: "y", plus: "más", minus: "menos",
  times: "por", by: "por", fold: "veces", equals: "igual a", to: "a", about: "unos", version: "versión", dash: "guion", more: "más de", less: "menos de",
  number: (n) => `número ${n}`, percent: (n) => `${n} por ciento`,
  time(h, m) { const hour = h === 1 ? "una" : card(this, String(h)); return m ? `${hour} y ${card(this, String(m))}` : `${hour} en punto`; },
});
add({
  code: "fr", locale: "fr", n: fr, point: "virgule", vsep: "point", dot: "point", at: "arobase", and: "et", plus: "plus", minus: "moins",
  times: "fois", by: "par", fold: "fois", equals: "égale", to: "à", about: "environ", version: "version", dash: "tiret", more: "plus de", less: "moins de",
  number: (n) => `numéro ${n}`, percent: (n) => `${n} pour cent`,
  time(h, m) { const hour = card(this, String(h)).replace(/\bun$/, "une"); return `${hour} ${h === 1 ? "heure" : "heures"}${m ? ` ${card(this, String(m))}` : ""}`; },
});
add({
  code: "de", locale: "de", n: de, one: "ein", point: "Komma", vsep: "Punkt", dot: "Punkt", at: "at", and: "und", plus: "plus", minus: "minus",
  times: "mal", by: "mal", fold: "mal", equals: "gleich", to: "bis", about: "etwa", version: "Version", dash: "Strich", more: "mehr als", less: "weniger als",
  number: (n) => `Nummer ${n}`, percent: (n) => `${n} Prozent`,
  time(h, m) { return `${h === 1 ? "ein" : card(this, String(h))} Uhr${m ? ` ${card(this, String(m))}` : ""}`; },
});
add({
  code: "it", locale: "it", n: it, one: "un", point: "virgola", vsep: "punto", dot: "punto", at: "chiocciola", and: "e", plus: "più", minus: "meno",
  times: "per", by: "per", fold: "volte", equals: "uguale", to: "a", about: "circa", version: "versione", dash: "trattino", more: "più di", less: "meno di",
  number: (n) => `numero ${n}`, percent: (n) => `${n} per cento`,
  time(h, m) { return `${card(this, String(h))}${m ? ` e ${card(this, String(m))}` : ""}`; },
});
add({
  code: "pt", locale: "pt-BR", n: pt as N2W, point: "vírgula", vsep: "ponto", dot: "ponto", at: "arroba", and: "e", plus: "mais", minus: "menos",
  times: "vezes", by: "por", fold: "vezes", equals: "igual a", to: "a", about: "cerca de", version: "versão", dash: "hífen", more: "mais de", less: "menos de",
  number: (n) => `número ${n}`, percent: (n) => `${n} por cento`,
  time(h, m) { const hour = h === 1 ? "uma" : h === 2 ? "duas" : card(this, String(h)); return m ? `${hour} e ${card(this, String(m))}` : `${hour} ${h === 1 ? "hora" : "horas"}`; },
});
add({
  code: "hi", locale: "hi", n: hi, point: "दशमलव", vsep: "पॉइंट", dot: "डॉट", at: "एट", and: "और", plus: "प्लस", minus: "माइनस",
  times: "गुणा", by: "बाय", fold: "गुना", equals: "बराबर", to: "से", about: "लगभग", version: "वर्ज़न", dash: "डैश",
  number: (n) => `नंबर ${n}`, percent: (n) => `${n} प्रतिशत`,
  time(h, m) { return m ? `${card(this, String(h))} बजकर ${card(this, String(m))} मिनट` : `${card(this, String(h))} बजे`; },
});
add({
  code: "zh", locale: "zh-CN", n: zh as N2W, opts: { formal: false }, unspaced: true, point: "点", vsep: "点", dot: "点", at: "艾特", and: "和", plus: "加", minus: "负",
  times: "乘", by: "乘", fold: "倍", equals: "等于", to: "到", about: "大约", version: "版本", dash: "横杠",
  number: (n) => `${n}号`, percent: (n) => `百分之${n}`,
  time(h, m) { return `${h === 2 ? "两" : card(this, String(h))}点${m ? `${m < 10 ? "零" : ""}${card(this, String(m))}分` : ""}`; },
});
add({
  code: "ja", locale: "ja", n: ja, unspaced: true, point: "点", vsep: "点", dot: "ドット", at: "アット", and: "と", plus: "プラス", minus: "マイナス",
  times: "かける", by: "かける", fold: "倍", equals: "イコール", to: "から", about: "約", version: "バージョン", dash: "ダッシュ",
  number: (n) => `${n}番`, percent: (n) => `${n}パーセント`,
  time(h, m) { return `${card(this, String(h))}時${m ? `${card(this, String(m))}分` : ""}`; },
});
// Hours and counted things take the native numbers (세 시, 두 개); minutes,
// money and measures the Sino-Korean ones n2words gives.
const KO_ONES = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉"];
const KO_TENS = ["", "열", "스물", "서른", "마흔", "쉰", "예순", "일흔", "여든", "아흔"];
const koNative = (n: number) => (n === 20 ? "스무" : KO_TENS[Math.floor(n / 10)]! + KO_ONES[n % 10]!);
add({
  code: "ko", locale: "ko", n: ko, point: "점", vsep: "점", dot: "닷", at: "골뱅이", and: "그리고", plus: "플러스", minus: "마이너스",
  times: "곱하기", by: "곱하기", fold: "배", equals: "이퀄", to: "에서", about: "약", version: "버전", dash: "대시",
  number: (n) => `${n}번`, percent: (n) => `${n} 퍼센트`,
  time(h, m) { return `${h >= 1 && h <= 12 ? koNative(h) : card(this, String(h))} 시${m ? ` ${card(this, String(m))} 분` : ""}`; },
});
const DECIMAL = new Map(Object.values(LANGS).map((l) => [l.code, new Intl.NumberFormat(l.locale).formatToParts(1.5).find((p) => p.type === "decimal")!.value]));

/** A non-negative integer as words (n2words). */
function card(L: Lang, n: string): string {
  const s = L.n.toCardinal(n, L.opts);
  return L.code === "zh" ? s.replace(/^一十/, "十") : s;
}
const digits = (L: Lang, s: string) => [...s].map((d) => card(L, d)).join(L.unspaced ? "" : " ");
const sp = (L: Lang) => (L.unspaced ? "" : " ");

/** An integer and its decimal digits as words: a leading zero, an ungrouped
 *  run over nine digits (an id) or anything past fifteen reads digit by digit,
 *  and digits after the mark read one by one ("three point one four"). */
function words(L: Lang, int: string, frac?: string, grouped = false): string {
  const whole = int === "" ? "" : (int.length > 1 && int[0] === "0") || (!grouped && int.length > 9) || int.length > 15 ? digits(L, int) : card(L, int);
  if (frac === undefined) return whole;
  return `${whole}${whole ? sp(L) : ""}${L.point}${sp(L)}${digits(L, frac)}`;
}

interface Num { int: string; frac?: string; grouped: boolean }
/** A written number split the way `lang` writes it: with two kinds of mark the
 *  last is the decimal one; with one mark, it is decimal when it is the
 *  language's decimal mark or not followed by exactly three digits ("1,200" is
 *  a thousands group in English, "3.5" a decimal even in German). Null when the
 *  groups don't parse ("1,2,3"). */
function parseNum(tok: string, lang: string): Num | null {
  const marks = tok.match(/[.,  ]/g);
  if (!marks) return { int: tok, grouped: false };
  const parts = tok.split(/[.,  ]/);
  const last = marks[marks.length - 1]!, tail = parts[parts.length - 1]!;
  const decimal = (last === "." || last === ",") && (marks.some((m) => m !== last) || (marks.length === 1 && (last === DECIMAL.get(lang) || tail.length !== 3)));
  const groups = decimal ? parts.slice(0, -1) : parts;
  const groupMarks = decimal ? marks.slice(0, -1) : marks;
  if (groupMarks.some((m) => m !== groupMarks[0])) return null;
  // Indian grouping (1,23,456) takes two-digit groups before the last three.
  if (groups.length > 1 && (groups[0]!.length > 3 || groups[0] === "" || groups.slice(1).some((g) => g.length !== 3 && g.length !== 2) || groups[groups.length - 1]!.length !== 3)) return null;
  return { int: groups.join(""), frac: decimal ? tail : undefined, grouped: groups.length > 1 };
}
const NUM = String.raw`\d+(?:[.,  ]\d+)*`;
const readNum = (L: Lang, tok: string): string => {
  const p = parseNum(tok, L.code);
  return p ? words(L, p.int, p.frac, p.grouped) : tok.replace(/\d+/g, (d) => words(L, d));
};
/** `n` times 10^k, as integer and fraction digit strings: "2.5" and 6 → "2500000". */
function shift(n: Num, k: number): Num {
  const all = n.int + (n.frac ?? ""), at = n.int.length + k;
  const int = (all.padEnd(at, "0").slice(0, at).replace(/^0+(?=\d)/, "")), frac = all.slice(at).replace(/0+$/, "");
  return { int, frac: frac || undefined, grouped: true };
}
const SCALE: Record<string, number> = { k: 3, M: 6, mn: 6, B: 9, bn: 9, T: 12 };

// English says a year in pairs ("nineteen eighty-four") and 2000-2009 whole;
// German says 1100-1999 in hundreds ("neunzehnhundertvierundachtzig");
// Chinese reads a year digit by digit (二零二六年).
function pairs(L: Lang, n: number): string {
  const hi = Math.floor(n / 100), lo = n % 100;
  return lo === 0 ? `${card(L, String(hi))} hundred` : `${card(L, String(hi))} ${lo < 10 ? "oh " : ""}${card(L, String(lo))}`;
}
function year(L: Lang, y: string): string {
  const n = Number(y);
  if (L.code === "en") return n >= 2000 && n < 2010 ? card(L, y) : pairs(L, n);
  if (L.code === "de" && n >= 1100 && n < 2000) return `${card(L, String(Math.floor(n / 100)))}hundert${n % 100 ? card(L, String(n % 100)) : ""}`;
  return L.code === "zh" ? digits(L, y) : card(L, y);
}
const isYear = (n: number) => n >= 1100 && n < 2100;

const ordinal = (L: Lang, n: string, fem = false): string => {
  if (L.code === "es") return L.n.toOrdinal(n, { gender: fem ? "feminine" : "masculine" });
  const s = L.n.toOrdinal(n);
  return fem && (L.code === "pt" || L.code === "it") ? s.replace(/o\b/g, "a") : s;
};

const nf = new Map<string, Intl.NumberFormat>();
/** `said` put where Intl places the number in `value` formatted with `opts`:
 *  "15 por ciento", "摂氏 20 度", "每小时50公里"; the unit or currency name
 *  takes the plural `value` calls for. */
function around(L: Lang, value: number, said: string, opts: Intl.NumberFormatOptions): string {
  const key = `${L.locale} ${JSON.stringify(opts)}`;
  let f = nf.get(key);
  if (!f) nf.set(key, f = new Intl.NumberFormat(L.locale, opts));
  let out = "", placed = false;
  for (const p of f.formatToParts(value)) {
    if (!/^(?:integer|group|decimal|fraction|minusSign|plusSign)$/.test(p.type)) out += p.value;
    else if (!placed) { out += said; placed = true; }
  }
  return out;
}
/** A count before a noun: "1" as `one` where the language inflects it. */
const counted = (L: Lang, n: Num) => (n.int === "1" && !n.frac && L.one ? L.one : words(L, n.int, n.frac, n.grouped));

// ── money ────────────────────────────────────────────────────────────────
const SYMBOLS: Record<string, string> = { "$": "USD", "US$": "USD", "C$": "CAD", "A$": "AUD", "R$": "BRL", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW" };
const CODES = "USD|EUR|GBP|JPY|CNY|RMB|INR|KRW|CAD|AUD|BRL|MXN|CHF";
// English names: [one, many, minor one, minor many]; a currency without minor
// units reads its fraction as a decimal.
const EN_MONEY: Record<string, string[]> = {
  USD: ["dollar", "dollars", "cent", "cents"], EUR: ["euro", "euros", "cent", "cents"], GBP: ["pound", "pounds", "penny", "pence"],
  CAD: ["Canadian dollar", "Canadian dollars", "cent", "cents"], AUD: ["Australian dollar", "Australian dollars", "cent", "cents"],
  INR: ["rupee", "rupees", "paisa", "paise"], BRL: ["real", "reais", "centavo", "centavos"], MXN: ["peso", "pesos", "centavo", "centavos"],
  CHF: ["franc", "francs", "centime", "centimes"], JPY: ["yen", "yen"], CNY: ["yuan", "yuan"], KRW: ["won", "won"],
};
function money(L: Lang, n: Num, code: string): string {
  if (code === "RMB") code = "CNY";
  if (n.frac?.length === 1) n = { ...n, frac: `${n.frac}0` }; // $1.5 is a dollar fifty
  const cents = n.frac !== undefined && n.frac.length === 2;
  if (L.code === "en" && EN_MONEY[code]) {
    const [one, many, minorOne, minorMany] = EN_MONEY[code]!;
    const major = `${words(L, n.int, undefined, n.grouped)} ${n.int === "1" ? one : many}`;
    if (n.frac === undefined || /^0+$/.test(n.frac)) return major;
    if (!cents || !minorOne) return `${words(L, n.int, n.frac, n.grouped)} ${many}`;
    const minor = `${card(L, n.frac)} ${n.frac === "01" ? minorOne : minorMany}`;
    return /^0+$/.test(n.int) ? minor : `${major} and ${minor}`;
  }
  if (L.n.currencyValues?.currency.includes(code) && (n.frac === undefined || cents) && n.int.length <= 15) {
    const s = L.n.toCurrency(n.frac ? `${n.int}.${n.frac}` : n.int, { ...L.opts, currency: code });
    return L.code === "zh" ? s.replace(/^一十/, "十").replace(/整$/, "") : s;
  }
  const places = n.frac?.length ?? 0;
  return around(L, Number(`${n.int}.${n.frac ?? 0}`), words(L, n.int, n.frac, n.grouped),
    { style: "currency", currency: code, currencyDisplay: "name", minimumFractionDigits: places, maximumFractionDigits: places });
}

// ── units ────────────────────────────────────────────────────────────────
// Intl knows these by name in every language; the rest are English only
// (elsewhere the engine reads the symbol). Case matters: 5G is not 5 grams.
const INTL_UNITS: Record<string, string> = {
  km: "kilometer", m: "meter", cm: "centimeter", mm: "millimeter", mi: "mile", ft: "foot", yd: "yard", kg: "kilogram", g: "gram",
  lb: "pound", lbs: "pound", oz: "ounce", L: "liter", ml: "milliliter", mL: "milliliter", "°C": "celsius", "ºC": "celsius", "°F": "fahrenheit",
  "°": "degree", "km/h": "kilometer-per-hour", kph: "kilometer-per-hour", mph: "mile-per-hour", ms: "millisecond", sec: "second", secs: "second",
  min: "minute", mins: "minute", h: "hour", hr: "hour", hrs: "hour", KB: "kilobyte", kB: "kilobyte", MB: "megabyte", GB: "gigabyte", TB: "terabyte",
  PB: "petabyte", Mb: "megabit", Gb: "gigabit", Mbps: "megabit-per-second", Gbps: "gigabit-per-second",
};
const EN_UNITS: Record<string, [string, string]> = {
  mg: ["milligram", "milligrams"], GHz: ["gigahertz", "gigahertz"], MHz: ["megahertz", "megahertz"], kHz: ["kilohertz", "kilohertz"], Hz: ["hertz", "hertz"],
  kW: ["kilowatt", "kilowatts"], W: ["watt", "watts"], kWh: ["kilowatt hour", "kilowatt hours"], V: ["volt", "volts"], mAh: ["milliamp hour", "milliamp hours"],
  px: ["pixel", "pixels"], fps: ["frame per second", "frames per second"], dB: ["decibel", "decibels"], GiB: ["gibibyte", "gibibytes"], MiB: ["mebibyte", "mebibytes"],
};
const alt = (keys: string[]) => keys.sort((a, b) => b.length - a.length).map((k) => k.replace(/[/$.]/g, "\\$&")).join("|");
const UNIT_RE = new RegExp(String.raw`(?<![\p{L}\d.,])(${NUM})\s?(${alt([...Object.keys(INTL_UNITS), ...Object.keys(EN_UNITS)])})(?![\p{L}\d])`, "gu");

// ── dates ────────────────────────────────────────────────────────────────
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const EN_MONTH = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
const DE_MONTH = "(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)";
const KO_MONTH: Record<string, string> = { 6: "유", 10: "시" }; // 유월, 시월

/** A calendar date in `L`, in the order and words Intl gives it: "September
 *  twenty-fifth, twenty twenty-six", "veinticinco de septiembre de dos mil
 *  veintiséis", "二零二六年九月二十五日". Null for an impossible date. */
function date(L: Lang, y: number, m: number, d: number): string | null {
  const t = Date.UTC(y, m - 1, d);
  if (m < 1 || m > 12 || new Date(t).getUTCDate() !== d) return null;
  const parts = new Intl.DateTimeFormat(L.locale, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }).formatToParts(t);
  return parts.map((p, i) => {
    if (p.type === "year") return year(L, p.value);
    if (p.type === "day") return L.code === "en" || L.code === "de" ? ordinal(L, p.value) : L.code === "fr" && d === 1 ? "premier" : card(L, p.value);
    if (p.type === "month" && /^\d+$/.test(p.value)) return KO_MONTH[p.value] && L.code === "ko" ? KO_MONTH[p.value]! : card(L, p.value);
    if (p.type === "literal" && L.code === "de" && parts[i - 1]?.type === "day") return p.value.replace(".", "");
    return p.value;
  }).join("");
}

// ── names ────────────────────────────────────────────────────────────────
// A name needs a known file extension or domain ending, so prose never
// gains a "dot". Endings with no vowel (tsx, md) and a few others are spelled.
const NAME_END = "tsx?|jsx?|mjs|cjs|json|jsonl|css|scss|less|html?|md|mdx|py|rs|go|rb|java|kts?|swift|c|cc|cpp|h|hpp|sh|bash|zsh|yml|yaml|toml|xml|sql|php"
  + "|lock|txt|csv|ipynb|pdf|png|jpe?g|gif|svg|webp|mp3|mp4|wav|zip|gz|tar|env|log|ini|conf|docx?|xlsx?|pptx?|vue|svelte|lua|dart|scala|exe|dmg|wasm|onnx|gguf|parquet"
  + "|com|org|net|io|dev|ai|app|co|edu|gov|us|uk|de|fr|es|jp|cn|kr|br|ca|au|eu|tv|xyz|info|biz|gg|ly|fm|page|site|tech|cloud";
const DOTTED_NAME = new RegExp(String.raw`\b[\w-]+(?:\.[\w-]+)*\.(?:${NAME_END})\b`, "gi");
const SPELLED_ENDS = new Set(["io", "ai", "uk", "us", "eu"]);
const spellEnd = (s: string) => (!/[aeiou]/i.test(s) || SPELLED_ENDS.has(s.toLowerCase()) ? s.toUpperCase().split("").join(" ") : s);
const dotted = (L: Lang, name: string) => name.split(".").map((s, i, a) => (i === a.length - 1 && i > 0 ? spellEnd(s) : s)).join(` ${L.dot} `);

// Initialisms read letter by letter: any all-capitals word with no vowel, and
// these with one. Words that are said as words (NASA, JSON, SCUBA) are left.
const SPELLED = new Set(("AI UI UX API CPU GPU TPU NPU URL URI UUID ID IO IP OS AWS IDE CEO CTO CFO COO ETA FAQ GUI USB UK US EU UN USA IBM AMD "
  + "ETL ORM OCR AR VR EOD FYI IDK IMO IOT IOU UPS EST PST UTC CET ASR IQ EV OEM OSS NYC").split(" "));
const spellOut = (s: string) => s.split("").join(" ");

// Things said by name in English only: elsewhere "e.g." has its own words.
const ABBREVIATIONS: Record<string, [RegExp, string][]> = {
  en: [[/\be\.g\./gi, "for example"], [/\bi\.e\./gi, "that is"], [/\betc\./gi, "et cetera"], [/\bvs\.?(?=\s)/gi, "versus"], [/\bapprox\./gi, "approximately"],
    [/\ba\.k\.a\./gi, "also known as"], [/\bw\/o\b/gi, "without"], [/\bw\/(?=\s)/gi, "with"], [/\bDr\.(?=\s+\p{Lu})/gu, "Doctor"], [/\bMr\.(?=\s)/g, "Mister"],
    [/\bMrs\.(?=\s)/g, "Missus"], [/\bNo\.\s?(?=\d)/g, "number "]],
  es: [[/\bp\.\s?ej\./gi, "por ejemplo"], [/\betc\./gi, "etcétera"], [/\bn\.?º\s?(?=\d)/gi, "número "], [/\bSr\.(?=\s)/g, "señor"], [/\bSra\.(?=\s)/g, "señora"], [/\bDr\.(?=\s)/g, "doctor"]],
  fr: [[/\bp\.\s?ex\./gi, "par exemple"], [/\betc\./gi, "et cetera"], [/\bn[°º]\s?(?=\d)/gi, "numéro "], [/\bM\.(?=\s\p{Lu})/gu, "monsieur"], [/\bMme\.?(?=\s)/g, "madame"]],
  de: [[/\bz\.\s?B\./g, "zum Beispiel"], [/\bd\.\s?h\./g, "das heißt"], [/\busw\./g, "und so weiter"], [/\bbzw\./g, "beziehungsweise"], [/\bca\./g, "circa"], [/\bNr\.\s?(?=\d)/g, "Nummer "]],
  it: [[/\becc\./gi, "eccetera"], [/\bn\.\s?(?=\d)/g, "numero "]],
  pt: [[/\betc\./gi, "etcétera"], [/\bn\.?º\s?(?=\d)/gi, "número "], [/\bSr\.(?=\s)/g, "senhor"], [/\bSra\.(?=\s)/g, "senhora"]],
};
const EN_FRACTIONS: Record<string, string> = { "1/2": "one half", "1/3": "one third", "2/3": "two thirds", "1/4": "one quarter", "3/4": "three quarters", "½": "one half", "⅓": "one third", "⅔": "two thirds", "¼": "one quarter", "¾": "three quarters" };

// Table and list furniture: column bars, rules (|---|, ===), box drawing, bullets.
const FURNITURE = String.raw`[|¦｜│┃║\u2500-\u257F•▪◦‣●■▶►]|(?<![\p{L}\d]):?[-=_*]{3,}:?(?![\p{L}\d])|(?<!\S)·(?!\S)`;
const FURNITURE_RUN = new RegExp(String.raw`(?:\s*(?:${FURNITURE}))+\s*`, "gu");
const STOP = /[,.;:!?，。、；：！？।]/u;

const PLACEHOLDER = 0xe000, PLACEHOLDERS = 0x1900; // the BMP private use area
const WIDE_DIGITS = /[０-９०-९]/g;

/**
 * `text` as a voice should say it in `lang` (ISO 639-1; unknown codes read as
 * English). `lexicon` entries match the text as written and their respellings
 * are spoken as typed: matched first, held out of every pass, put back last.
 * O(n) per pass over a chunk of n characters, plus the lexicon's O(n · L).
 */
export const normalizeSpeech = (text: string, langCode: string, lexicon?: Lexicon | null): string => normalizeAligned(text, langCode, lexicon).said;

/** normalizeSpeech's `said`, and `from`: for each character of `said` (and one
 *  past its end), the index in `text` it was read from. What a pass rewrites
 *  maps its output evenly over the characters it replaced, so "$1,200" gives
 *  every character of "one thousand two hundred dollars" a place in "$1,200",
 *  in order. `from` never decreases. Same cost as normalizeSpeech. */
export function normalizeAligned(text: string, langCode: string, lexicon?: Lexicon | null): { said: string; from: number[] } {
  const L = lang(langCode);
  const held: string[] = [], heldLen: number[] = [];
  const hold = (said: string, written: string) => {
    if (held.length >= PLACEHOLDERS) return said;
    heldLen.push(written.length);
    return String.fromCharCode(PLACEHOLDER + held.push(said) - 1);
  };
  let s = lexicon ? lexicon(text, hold) : text;
  let src: number[] = [];
  for (let i = 0, at = 0; i <= s.length; i++) {
    src.push(Math.min(at, text.length));
    const k = s.charCodeAt(i) - PLACEHOLDER;
    at += k >= 0 && k < held.length ? heldLen[k]! : 1;
  }
  const r = (re: RegExp, f: (...m: string[]) => string) => {
    let out: number[] | null = null, last = 0;
    s = s.replace(re, (m: string, ...rest: unknown[]) => {
      const said = (f as (...a: unknown[]) => string)(m, ...rest);
      const at = rest.find((x) => typeof x === "number") as number, end = at + m.length, lo = src[at]!, span = src[end]! - lo;
      out ??= [];
      for (let i = last; i < at; i++) out.push(src[i]!);
      for (let j = 0; j < said.length; j++) out.push(lo + Math.floor((j * span) / said.length));
      last = end;
      return said;
    });
    if (out) { for (let i = last; i < src.length; i++) (out as number[]).push(src[i]!); src = out; }
  };
  const n = (tok: string) => readNum(L, tok);
  const num = (tok: string) => parseNum(tok, L.code) ?? { int: tok.replace(/\D/g, ""), grouped: false };

  r(WIDE_DIGITS, (c) => String((c.charCodeAt(0) - (c >= "０" ? 0xff10 : 0x0966)) % 10));
  r(/(\d)️?⃣/g, (_, d) => d); // keycap digits
  r(/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}‍️]/gu, () => " ");
  // Furniture between words is a pause; at an edge or beside punctuation, nothing.
  const pause = L.code === "zh" ? "，" : L.code === "ja" ? "、" : ", ";
  r(FURNITURE_RUN, (m, at, whole) => {
    const before = whole[+at - 1], after = whole[+at + m.length];
    return before === undefined || after === undefined || STOP.test(before) || STOP.test(after) ? " " : pause;
  });

  // Addresses: a URL as its site, a path as its file name, then the dots.
  r(/\bhttps?:\/\/(?:www\.)?([^\s/?#]+)\S*/gi, (_, host) => host.replace(/:(\d+)$/, " $1"));
  r(/\bwww\.(?=[\w-]+\.)/gi, () => "");
  r(/\blocalhost:(?=\d)/gi, () => "localhost ");
  r(/(?:[A-Za-z]:\\|~?\/)?(?:[\w.-]+[/\\])+([\w-]+\.\w{1,6})\b/g, (_, file) => file);
  r(/([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)/g, (_, user, host) =>
    `${user.replace(/\./g, ` ${L.dot} `).replace(/_/g, " ").replace(/\+/g, ` ${L.plus} `)} ${L.at} ${dotted(L, host)}`);
  r(/\b[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)+(?=\()/g, (m) => m.split(".").join(` ${L.dot} `)); // console.log(
  r(DOTTED_NAME, (m) => dotted(L, m));
  r(/(^|\s)\.(?=[a-z][\w-]*)/g, (_, pre) => `${pre}${L.dot} `); // .env
  r(/(\w)\(\)/g, (_, c) => c);

  // Code: identifiers into words, flags by their dashes.
  r(/\b([a-z]{2,})((?:[A-Z][a-z0-9]*)+)\b/g, (_, head, humps) => `${head} ${humps.replace(/(?!^)(?=[A-Z])/g, " ")}`);
  r(/(?<=[\p{L}\d])_+(?=[\p{L}\d])/gu, () => " ");
  r(/(^|\s)--(?=[a-z])/g, (_, pre) => `${pre}${L.dash} ${L.dash} `);
  r(/(^|\s)-(?=[a-zA-Z]\b)/g, (_, pre) => `${pre}${L.dash} `);

  for (const [re, said] of ABBREVIATIONS[L.code] ?? []) r(re, () => said);

  // Dates and times, before their digits read as anything else.
  r(/\b(\d{4})-(\d{2})-(\d{2})(?:T(?=\d{2}:))?/g, (m, y, mo, d) => date(L, +y, +mo, +d) ?? m);
  r(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/g, (m, a, b, y) => {
    const monthFirst = L.code === "en" ? +a <= 12 : +b > 12;
    return date(L, +y, monthFirst ? +a : +b, monthFirst ? +b : +a) ?? m;
  });
  if (L.code === "en") {
    r(new RegExp(String.raw`\b${EN_MONTH}\s(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s(\d{4})\b)?`, "g"), (m, mon, d, y) => {
      const name = EN_MONTHS.find((x) => x.startsWith(mon.slice(0, 3)))!;
      return +d >= 1 && +d <= 31 ? `${name} ${ordinal(L, d)}${y ? `, ${year(L, y)}` : ""}` : m;
    });
    r(new RegExp(String.raw`\b([Tt]he\s)?(\d{1,2})(?:st|nd|rd|th)?\s(?:of\s)?${EN_MONTH}(?=\s|,|$)`, "g"), (m, the, d, mon) =>
      +d >= 1 && +d <= 31 ? `${the ?? "the "}${ordinal(L, d)} of ${EN_MONTHS.find((x) => x.startsWith(mon.slice(0, 3)))!}` : m);
  }
  if (L.code === "de") r(new RegExp(String.raw`\b(\d{1,2})\.\s?${DE_MONTH}`, "g"), (_, d, mon) => `${ordinal(L, d)} ${mon}`);
  r(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(?:\s?([ap])\.?\s?m\b\.?)?(?:\s?(?:Uhr\b|बजे))?/gi, (_, h, m, sec, ap) => {
    const said = L.time(+h, +m, !!ap) + (sec ? `${sp(L)}${L.code === "en" && +sec < 10 ? "oh " : ""}${card(L, sec)}` : "");
    return ap ? `${said} ${ap.toUpperCase()} M` : said;
  });
  r(/\b(1[0-2]|0?[1-9])\s?([ap])\.?\s?m\b\.?/gi, (_, h, ap) => `${L.time(+h, 0, true)} ${ap.toUpperCase()} M`);
  if (L.code === "fr") r(/\b([01]?\d|2[0-3])\s?h\s?([0-5]\d)?(?![\p{L}\d])/gu, (_, h, m) => L.time(+h, m ? +m : 0, false));
  if (L.code === "de") r(/\b(\d{1,2})\s?Uhr\b/g, (_, h) => L.time(+h, 0, false));
  if (L.code === "zh") r(/(\d{1,2})点(?!\d)/g, (_, h) => L.time(+h, 0, false));
  // A date after a German preposition takes the dative: "am dritten Oktober".
  if (L.code === "de") r(/\b(am|vom|zum|dem|bis zum|seit dem|ab dem)\s(\p{L}+te)(?=\s)/giu, (_, pre, ord) => `${pre} ${ord}n`);

  // Numbers read as digits: phones, versions, addresses.
  r(/(?:\+\d{1,3}(?:[\s.-]\d{1,4}){2,5}|(?:\b1[-.\s])?(?:\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.]\d{4})(?![\d-])/g, (m) =>
    (m[0] === "+" ? `${L.plus} ` : "") + m.split(/\D+/).filter(Boolean).map((g) => digits(L, g)).join(", "));
  r(/\bv(\d+(?:\.\d+)*)\b/g, (_, v) => `${L.version} ${v.split(".").map((p: string) => card(L, p)).join(` ${L.vsep} `)}`);
  r(/(?<![\d.])\d+(?:\.\d+){2,}(?![\d]|\.\d)/g, (m) => {
    const parts = m.split(".");
    const ip = parts.length === 4 && parts.every((p) => +p <= 255);
    return parts.map((p) => card(L, p)).join(` ${ip ? L.dot : L.vsep} `);
  });

  // Ranges and signs, while both ends are still digits.
  r(/(?<![\p{L}\d.,\-–])(\d[\d.,]*)\s?[-–\u2014~]\s?(?=[$€£¥₹₩]?\d[\d.,]*(?![\d\-–]))/gu, (_, a) => `${a} ${L.to} `);
  r(/(^|[\s(=:,])[-−](?=\d)/g, (_, pre) => `${pre}${L.minus} `);
  r(/(^|\s)~\s?(?=\d)/g, (_, pre) => `${pre}${L.about} `);
  if (L.more) r(/(^|\s)([<>])\s?(?=\d)/g, (_, pre, op) => `${pre}${op === "<" ? L.less : L.more} `);

  // Money, percentages, measures.
  const moneyScale = String.raw`(?:\s?(k|K|M|mn|B|bn|T)\b|\s(thousand|million|billion|trillion)\b)?`;
  r(new RegExp(String.raw`(US\$|C\$|A\$|R\$|[$€£¥₹₩])\s?(${NUM})${moneyScale}`, "g"), (_, sym, v, k, word) => {
    const code = sym === "¥" && L.code === "zh" ? "CNY" : SYMBOLS[sym]!;
    if (word) return `${n(v)} ${word} ${EN_MONEY[code]?.[1] ?? code}`; // English text: "$2 million"
    return money(L, k ? shift(num(v), SCALE[k.replace(/^K$/, "k")]!) : num(v), code);
  });
  r(new RegExp(String.raw`\b(${CODES})\s?(${NUM})\b|(${NUM})\s?(€|${CODES})(?![\p{L}])`, "gu"), (_, c1, v1, v2, c2) =>
    money(L, num(v1 ?? v2), c2 === "€" ? "EUR" : (c1 ?? c2)));
  r(new RegExp(String.raw`(${NUM})\s?%`, "g"), (_, v) => L.percent(n(v)));
  r(UNIT_RE, (m, v, unit) => {
    const val = num(v);
    if (INTL_UNITS[unit]) return around(L, Number(`${val.int}.${val.frac ?? 0}`), counted(L, val), { style: "unit", unit: INTL_UNITS[unit], unitDisplay: "long", maximumFractionDigits: 20 });
    return L.code === "en" ? `${n(v)} ${EN_UNITS[unit]![v === "1" ? 0 : 1]}` : m;
  });
  r(new RegExp(String.raw`(?<![\p{L}\d.,])(${NUM})(k|M|B|bn)\b`, "gu"), (_, v, k) => { const q = shift(num(v), SCALE[k]!); return words(L, q.int, q.frac, true); });
  r(/(\d)K\b/g, (_, d) => `${d} K`); // 4K is a resolution, 5K a race
  r(new RegExp(String.raw`(${NUM})\s?[x×]\s?(?=\d)`, "g"), (m, v) => `${v} ${L.code === "en" && !/\s/.test(m) ? L.by : L.times} `);
  r(new RegExp(String.raw`(${NUM})[x×](?![\p{L}\d])`, "gu"), (_, v) => `${n(v)}${sp(L)}${L.fold}`);

  // Ordinals and the rest of what numbers are glued to.
  if (L.code === "en") {
    r(/\b(\d+)(?:st|nd|rd|th)\b/gi, (_, d) => ordinal(L, d));
    r(/(?<![\d/])(\d\/\d)(?![\d/])|[½⅓⅔¼¾]/g, (m) => EN_FRACTIONS[m] ?? m);
    r(/\b24\/7\b/g, () => "twenty-four seven");
    r(/'?\b(\d{2}|1[1-9]\d{2}|20\d{2})s\b/g, (m, d) => (d.length === 2 && !m.startsWith("'") && d[1] !== "0" ? m
      : (d.length === 2 ? card(L, d) : year(L, d)).replace(/y$/, "ie") + "s"));
    r(/\b(\d{3,4})p\b/g, (_, d) => `${pairs(L, +d)} p`); // 1080p
  }
  if (L.code === "es" || L.code === "pt" || L.code === "it") r(/\b(\d+)\.?([ºª])/g, (_, d, g) => ordinal(L, d, g === "ª"));
  if (L.code === "fr") r(/\b(\d+)(er|re|ère|e|ème|eme)\b/g, (_, d, suf) => (d === "1" ? (suf === "er" ? "premier" : "première") : ordinal(L, d)));
  if (L.code === "ko") {
    r(/(\d{1,2})\s?(?=개|명|살|마리|번째|잔|권|병|시간|시|달)/g, (m, d) => (+d >= 1 && +d < 100 ? `${koNative(+d)} ` : m));
    r(/\b(6|10)월/g, (_, d) => `${KO_MONTH[d]}월`);
  }
  if (L.code === "zh") r(/(\d{4})(?=年)/g, (_, y) => digits(L, y));
  r(/(^|\s)#(?=\d)/g, (_, pre) => `${pre}\u0001`); // "#1", read with its number below
  r(/(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/g, () => " ");

  // Symbols between words.
  r(/\s*&+\s*/g, () => ` ${L.and} `);
  r(/(\w)\+\+/g, (_, c) => `${c} ${L.plus} ${L.plus}`);
  r(/(^|\s)\+(?=\d)/g, (_, pre) => `${pre}${L.plus} `);
  r(/\s\+\s|(?<=\d)\+(?!\d)/g, () => ` ${L.plus} `);
  r(/\s=\s|(?<=\d)=(?=\d)/g, () => ` ${L.equals} `);
  r(/\s?±\s?/g, () => ` ${L.plus}${L.code === "en" ? " or" : ""} ${L.minus} `);
  r(/\s?→\s?/g, () => ` ${L.to} `);
  r(/(^|\s)@(?=\w)/g, (_, pre) => `${pre}${L.at} `);
  r(/(?<=\p{L})\/(?=\p{L})/gu, () => " ");
  r(/(?<=\b[A-G])#(?![\w#])/g, () => " sharp"); // C#, F#
  r(/#(?=\p{L})/gu, () => "");

  // Initialisms, unless the whole chunk is capitals (shouting, not acronyms).
  if (/\p{Ll}/u.test(s)) r(/\b([A-Z]{2,6})(s?)\b/g, (m, w, plural) =>
    (!/[AEIOUY]/.test(w) || SPELLED.has(w) ? spellOut(w) + (plural ? "'s" : "") : m));

  // Every number left: years in English and German, the rest as counted.
  r(new RegExp(String.raw`(\u0001)?(${NUM}|(?<![\d\p{L}])\.\d+)`, "gu"), (_, hash: string | undefined, tok: string) => {
    const p = parseNum(tok, L.code);
    const said = p && !p.grouped && !p.frac && p.int.length === 4 && isYear(+p.int) && (L.code === "en" || L.code === "de") ? year(L, p.int) : n(tok);
    return hash ? L.number(said) : said;
  });
  r(/\u0001/g, () => "#");

  if (held.length) r(/[-]/g, (c) => held[c.charCodeAt(0) - PLACEHOLDER] ?? c);
  r(/\s+([,.!?;:])/g, (_, p) => p);
  r(/\s+/g, () => " ");
  r(/^ | $/g, () => "");
  return { said: s, from: src };
}
