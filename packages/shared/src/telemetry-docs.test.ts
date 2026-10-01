import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { telemetrySchema as schema } from "./telemetry-schema";

// docs/TELEMETRY.md is the public list of everything OpenLive can send. This
// test fails when it and telemetry-schema.ts disagree, in either direction: an
// event, property, label or setting the schema has and the doc lacks, or the
// reverse. It reads the doc, so the doc keeps a fixed format:
//
//   ### `event_name`                 one heading per event, the name in backticks
//   Limit: <text>.                   worded as limitText() words the schema's cap
//   | Property | Meaning | Values | Sent |     the first table under the heading
//     Property  one or more `names`, comma separated
//     Values    a number, true or false, or a version: exactly what valuesText() returns.
//               A label list: the `labels` written out and/or [links](#heading) to a
//               list under that heading (the first column of its table, else the
//               `labels` in its text). The two are joined.
//     Sent      "always" for a required property, "sometimes" for an optional one
//     Meaning   anything, but not empty
//   ## Common properties             the same table, for schema.common
//   ## Reported settings             | Setting | Meaning | Values | Subject |, a row per schema.settings entry
//
// A failure says what to write. After an intended schema change, add or edit
// the row in the doc, with a Meaning a reader can use.

type Spec = { k: string; opt?: boolean; values?: readonly string[]; max?: number; min?: number; step?: number; places?: number; pattern?: string };
type Specs = Record<string, Spec>;
type Limit = {
  perLaunch?: number; launchKey?: readonly string[]; perDay?: number; perDayPerKey?: number; dayKey?: readonly string[];
  dedupeMs?: number; dedupeKey?: readonly string[]; oncePerInstall?: true; oncePerValueOf?: string;
};
const events = schema.events as unknown as Record<string, { props: Specs; limit?: Limit }>;
const settings = schema.settings as unknown as Record<string, { values: readonly string[]; subject?: string }>;
const common = schema.common as unknown as Specs;

// ── reading the doc ─────────────────────────────────────────────────────────
interface Section { title: string; lines: string[] }
type Row = Record<string, string>;

// Windows checks text out with CRLF.
const doc = readFileSync(new URL("../../../docs/TELEMETRY.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9 _-]/g, "").trim().replace(/ /g, "-");
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const ticks = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
const tick = (v: string) => `\`${v}\``;

const sections: Section[] = [];
let fenced = false;
for (const line of doc.split("\n")) {
  if (line.startsWith("```")) fenced = !fenced;
  const heading = fenced ? null : /^#{1,6} (.+)$/.exec(line);
  if (heading) sections.push({ title: heading[1]!, lines: [] });
  else sections.at(-1)?.lines.push(line);
}
const bySlug = new Map(sections.map((s) => [slug(s.title), s]));
const byTitle = new Map(sections.map((s) => [s.title, s]));

/** The first table of a section, one record per row, keyed by the header cells. */
function table(section: Section | undefined): Row[] | undefined {
  const start = section?.lines.findIndex((l) => l.startsWith("|")) ?? -1;
  if (!section || start < 0) return undefined;
  const block = section.lines.slice(start);
  const end = block.findIndex((l) => !l.startsWith("|"));
  const lines = end < 0 ? block : block.slice(0, end);
  const head = cells(lines[0]!);
  return lines.slice(2).map((l) => Object.fromEntries(cells(l).map((c, i) => [head[i] ?? `#${i}`, c])));
}

/** What a list section holds: the first column of its table, else the labels in its text. */
const listOf = (s: Section): string[] => {
  const rows = table(s);
  return rows ? rows.flatMap((r) => ticks(Object.values(r)[0] ?? "")) : ticks(s.lines.join("\n"));
};

/** The labels a Values cell stands for: the ones written out, plus every list it links to. */
function labelsOf(cell: string, where: string, problems: string[]): Set<string> {
  const out = new Set(ticks(cell));
  for (const [, target] of cell.matchAll(/\]\(#([^)]+)\)/g)) {
    const list = bySlug.get(target!);
    if (list) listOf(list).forEach((v) => out.add(v));
    else problems.push(`${where}: links to #${target}, which is not a heading`);
  }
  return out;
}

// ── what the doc must say, from the schema ──────────────────────────────────
const STRINGS = new Map([
  [common.app_version!.pattern, "version number, like 1.2.3 or 1.2.3-beta.1"],
  [common.os_major!.pattern, "one or two digits (a major version, like 15), or linux"],
  [common.username!.pattern, "adjective, animal and eight hex characters, like swift-otter-1a2b3c4d"],
]);

/** The Values cell of a property that is not a list of labels. */
function valuesText(spec: Spec): string {
  switch (spec.k) {
    case "bool": return "true or false";
    case "int": return `whole number, ${spec.min ?? 0} to ${spec.max}${spec.step ? `, rounded to ${spec.step}` : ""}`;
    case "dec": return `number, 0 to ${spec.max}, rounded to ${10 ** -spec.places!}`;
    case "str": return STRINGS.get(spec.pattern!) ?? `(no description for the pattern ${spec.pattern}: add one to STRINGS)`;
    default: return `(unknown kind ${spec.k})`;
  }
}

const each = (keys: readonly string[]) => (keys.length > 1 ? `each combination of ${keys.map(tick).join(" and ")}` : `each ${tick(keys[0]!)}`);
/** The Limit line of an event: how often the schema lets it out. */
function limitText(l: Limit | undefined): string {
  if (!l) return "none.";
  const parts = [
    l.oncePerInstall && "once per install",
    l.oncePerValueOf && `once per install for each ${tick(l.oncePerValueOf)}`,
    l.perLaunch && `at most ${l.perLaunch} per launch${l.launchKey ? ` for ${each(l.launchKey)}` : ""}`,
    l.perDay && `at most ${l.perDay} per day`,
    l.perDayPerKey && `at most ${l.perDayPerKey} per day${l.dayKey ? ` for ${each(l.dayKey)}` : ""}`,
    l.dedupeMs && `the same ${l.dedupeKey?.map(tick).join(" and ") ?? "event"} is not sent again within ${l.dedupeMs / 60_000} minutes`,
  ].filter(Boolean);
  return `${parts.join("; ")}.`;
}

// ── comparing ───────────────────────────────────────────────────────────────
const setProblem = (at: string, what: string, want: readonly string[], have: Iterable<string>) => {
  const got = new Set(have);
  const missing = want.filter((v) => !got.has(v));
  const extra = [...got].filter((v) => !want.includes(v));
  return missing.length || extra.length ? [`${at}: ${what} lack ${JSON.stringify(missing)} and add ${JSON.stringify(extra)}`] : [];
};

/** The doc's rows against a spec table: every property once, its Sent, its Values, a Meaning. */
function propertyProblems(where: string, specs: Specs, section: Section | undefined): string[] {
  const rows = table(section);
  if (!rows) return [`${where}: no property table`];
  const problems: string[] = [];
  const rowOf = new Map<string, Row>();
  for (const row of rows) {
    for (const name of ticks(row.Property ?? "")) {
      if (rowOf.has(name)) problems.push(`${where}: ${name} is listed twice`);
      rowOf.set(name, row);
    }
  }
  problems.push(...setProblem(where, "the documented properties", Object.keys(specs), rowOf.keys()));
  for (const [name, spec] of Object.entries(specs)) {
    const row = rowOf.get(name);
    if (!row) continue;
    const at = `${where}.${name}`;
    const sent = spec.opt ? "sometimes" : "always";
    if (row.Sent !== sent) problems.push(`${at}: Sent should read "${sent}"`);
    if (!row.Meaning) problems.push(`${at}: no Meaning`);
    const cell = row.Values ?? "";
    if (at === "setting_changed.setting" || at === "setting_changed.value") {
      if (!cell.includes("](#reported-settings)")) problems.push(`${at}: Values should link to #reported-settings`);
    } else if (spec.k === "enum") {
      problems.push(...setProblem(at, "the Values", spec.values!, labelsOf(cell, at, problems)));
    } else if (cell !== valuesText(spec)) {
      problems.push(`${at}: Values should read "${valuesText(spec)}"`);
    }
  }
  return problems;
}

const eventSections = new Map(sections.flatMap((s) => {
  const name = /^`([a-z_0-9]+)`$/.exec(s.title)?.[1];
  return name ? [[name, s] as const] : [];
}));

describe("docs/TELEMETRY.md matches the telemetry schema", () => {
  it("has one section for each event, and none the schema lacks", () => {
    expect(sections.filter((s) => /^`[a-z_0-9]+`$/.test(s.title))).toHaveLength(eventSections.size);
    expect(setProblem("events", "the documented events", Object.keys(events), eventSections.keys())).toEqual([]);
  });

  it("describes every property of every event, with its values and whether it is always sent", () => {
    const problems = Object.entries(events).flatMap(([name, e]) => propertyProblems(name, e.props, eventSections.get(name)));
    expect(problems).toEqual([]);
  });

  it("states each event's limit as the schema sets it", () => {
    const problems = Object.entries(events).flatMap(([name, e]) => {
      const line = eventSections.get(name)?.lines.find((l) => l.startsWith("Limit: "));
      const want = `Limit: ${limitText(e.limit)}`;
      return line === want ? [] : [`${name}: the line should read "${want}"`];
    });
    expect(problems).toEqual([]);
  });

  it("describes the common properties", () => {
    expect(propertyProblems("common", common, byTitle.get("Common properties"))).toEqual([]);
  });

  it("lists every reported setting with its values and the kind of id it carries", () => {
    const section = byTitle.get("Reported settings");
    const rows = table(section) ?? [];
    const problems: string[] = [];
    const rowOf = new Map(rows.map((r) => [ticks(r.Setting ?? "")[0] ?? "", r]));
    problems.push(...setProblem("settings", "the documented settings", Object.keys(settings), rowOf.keys()));
    for (const [name, s] of Object.entries(settings)) {
      const row = rowOf.get(name);
      if (!row) continue;
      const subject = s.subject ? `${s.subject} id` : "none";
      if (row.Subject !== subject) problems.push(`settings.${name}: Subject should read "${subject}"`);
      if (!row.Meaning) problems.push(`settings.${name}: no Meaning`);
      problems.push(...setProblem(`settings.${name}`, "the Values", s.values, labelsOf(row.Values ?? "", `settings.${name}`, problems)));
    }
    expect(problems).toEqual([]);
  });

  it("says when each onboarding step fires and what each failure code means", () => {
    const problems = ["Onboarding steps", "Failure codes"].flatMap((title) => {
      const rows = table(byTitle.get(title));
      if (!rows) return [`${title}: no table`];
      return rows.flatMap((r) => (Object.values(r)[1] ? [] : [`${title}: ${Object.values(r)[0]} has no description`]));
    });
    expect(problems).toEqual([]);
  });

  it("only links to headings that exist", () => {
    const missing = [...doc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!).filter((target) => !bySlug.has(target));
    expect(missing).toEqual([]);
  });
});
