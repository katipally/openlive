import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AGENT_IDS,
  LANGUAGE_CODES,
  telemetrySchema as schema,
  type FeatureCounterKey,
  type TelemetryEventName,
  type TelemetryEventProps,
  type TelemetryFactProps,
  type TelemetryFactScope,
} from "./index";

type Spec = { k: string; opt?: boolean; values?: readonly string[]; pattern?: string; fold?: string; into?: Record<string, string> };
type Loose = Record<string, { props: Record<string, Spec>; limit?: Record<string, unknown>; derive?: Record<string, string[]> }>;
const events = schema.events as unknown as Loose;
const facts = schema.facts as unknown as Record<string, { event: string; props: Record<string, Spec> }>;

describe("telemetry schema contents", () => {
  it("has the 29 events, 36 counters and 4 fact scopes of the catalog", () => {
    expect(Object.keys(events)).toHaveLength(29);
    expect(schema.counters).toHaveLength(36);
    expect(Object.keys(facts).sort()).toEqual(["agent_call", "agent_flow", "call_renderer", "flow_owner"]);
  });

  it("lists 30 web onboarding steps (five tours) and the main and agent steps", () => {
    const steps = events.onboarding_step!.props.step!.values!;
    expect(steps.filter((s) => s.startsWith("tour_closed_"))).toHaveLength(5);
    expect(steps).toHaveLength(39);
    expect(new Set(steps).size).toBe(39);
    for (const s of ["flow_hook_started", "flow_hook_failed", "first_flow_summon", "first_call", "first_device_action", "flow_consent_granted", "first_agent_start_ok", "first_flow_reply", "first_call_reply", "activated", "first_lobby_open"]) {
      expect(steps).toContain(s);
    }
  });

  it("says how a tour ended and on which of its steps, and only there", () => {
    expect(events.onboarding_step!.props.tour_exit!.values).toEqual(["done", "skipped", "left"]);
    expect(events.onboarding_step!.props.tour_step).toMatchObject({ k: "int", min: 1, max: 9, opt: true });
  });

  it("reports what went wrong in a call beside what worked", () => {
    for (const p of ["mic_lost", "camera_failed", "screen_failed"]) {
      expect(events.call_session!.props[p], p).toMatchObject({ k: "int", opt: true });
      expect(facts.call_renderer!.props[p]!.fold, p).toBe("sum");
    }
  });

  it("carries the contract's rulings", () => {
    expect(events.flow_session!.props.ended_by!.values).toContain("sleep_or_lock");
    expect(events.flow_session!.props.ended_by!.values).not.toContain("sleep");
    expect(events.call_session!.props.ended_by!.values).not.toContain("link_lost");
    expect(events.flow_session!.props.stops).toBeDefined();
    expect(events.flow_session!.props.barge_ins).toBeDefined();
    expect(events.flow_session!.props.interrupted).toBeUndefined();
    expect(events.telemetry_disabled!.props.from!.values).toEqual(["notice", "settings"]);
    expect(events.telemetry_disabled!.props.days_since_first_open).toMatchObject({ k: "int", max: 999 });
  });

  it("lists no value that no code path sends", () => {
    expect(events.crash_detected!.props.reason!.values).not.toContain("dump_found");
    expect(events.os_permission_request!.props.asked_from!.values).not.toContain("orb_fix");
    expect(events.remote_ollama_prompt!.props.outcome!.values).not.toContain("blocked_not_packaged");
    expect(events.update_result!.props.error_kind!.values).not.toContain("none");
  });

  it("asks for feedback only within the caps the schema holds, and reports closed answers", () => {
    expect(schema.feedback).toEqual({
      minDaysAfterFirstOpen: 2, minDaysBetweenPrompts: 7, minDaysBetweenSessionRatings: 7, minDaysBetweenNps: 90, npsMinActiveDays: 7,
      ignoredInARowForBackoff: 2, backoffDays: 30, sessionMinAnsweredTurns: 2, sessionFreshHours: 12,
    });
    const p = events.feedback_given!;
    expect(p.limit).toEqual({ perDay: 1 });
    expect(p.props.outcome!.values).toEqual(["answered", "dismissed", "ignored", "never_again"]);
    expect(p.props.score).toMatchObject({ k: "int", max: 10, opt: true });
    expect(Object.values(p.props).every((s) => s.k !== "str")).toBe(true);
  });

  it("reports the screen lock setting as on or off", () => {
    expect((schema.settings as Record<string, { values: readonly string[] }>).end_on_lock!.values).toEqual(["on", "off"]);
  });

  it("has one counter prop per counter key, and no others", () => {
    expect(Object.keys(events.feature_usage!.props).sort()).toEqual([...schema.counters].sort());
  });

  it("stays in step with the ids other packages own", () => {
    expect(schema.subjects.agent).toEqual(AGENT_IDS);
    expect(events.call_session!.props.lang!.values).toEqual(LANGUAGE_CODES);
    expect(events.agent_action_result!.props.agent_id!.values).toEqual(AGENT_IDS);
  });
});

describe("telemetry schema is closed", () => {
  const all: [string, Spec][] = [
    ...Object.entries(schema.common),
    ...Object.entries(events).flatMap(([e, v]) => Object.entries(v.props).map(([p, s]): [string, Spec] => [`${e}.${p}`, s])),
    ...Object.entries(facts).flatMap(([e, v]) => Object.entries(v.props).map(([p, s]): [string, Spec] => [`${e}.${p}`, s])),
  ];

  it("has no free string: only enums, booleans, numbers and the three shapes for a version, an OS major and a username", () => {
    const strings = new Set(all.filter(([, s]) => s.k === "str").map(([, s]) => s.pattern));
    expect([...strings].sort()).toEqual(["^([0-9]{1,2}|linux)$", "^\\d+\\.\\d+\\.\\d+(-[A-Za-z0-9.]+)?$", "^[a-z]{3,12}-[a-z]{3,12}-[0-9a-f]{8}$"].sort());
    for (const [name, s] of all) expect(["enum", "bool", "int", "dec", "str"], name).toContain(s.k);
  });

  it("caps every number and never lists an empty enum", () => {
    for (const [name, s] of all) {
      if (s.k === "int" || s.k === "dec") expect((s as { max?: number }).max, name).toBeGreaterThan(0);
      if (s.k === "enum") expect(s.values!.length, name).toBeGreaterThan(0);
    }
  });

  it("has no em dash in any name or value", () => {
    expect(JSON.stringify(schema)).not.toContain(String.fromCharCode(0x2014));
  });

  it("names real props in every limit and derive rule", () => {
    for (const [name, e] of Object.entries(events)) {
      const l = e.limit ?? {};
      const keys = [...((l.launchKey as string[]) ?? []), ...((l.dayKey as string[]) ?? []), ...((l.dedupeKey as string[]) ?? [])];
      if (l.oncePerValueOf) keys.push(l.oncePerValueOf as string);
      for (const k of keys) expect(e.props[k], `${name}.${k}`).toBeDefined();
      if (l.launchKey) expect(l.perLaunch, name).toBeDefined();
      if (l.dayKey) expect(l.perDayPerKey, name).toBeDefined();
      if (l.dedupeKey) expect(l.dedupeMs, name).toBeDefined();
    }
    for (const src of events.flow_session!.derive!.acted!) expect(facts.agent_flow!.props[src]!.fold).toBe("sum");
  });
});

describe("telemetry facts fold into real event props", () => {
  it("names a target event prop of the same kind for every fact, or the percentile props for samples", () => {
    for (const [scope, f] of Object.entries(facts)) {
      const target = events[f.event]!.props;
      for (const [p, s] of Object.entries(f.props)) {
        expect(["sum", "last", "or", "max", "samples"], `${scope}.${p}`).toContain(s.fold);
        if (s.fold === "samples") {
          for (const out of Object.values(s.into!)) expect(target[out], `${scope}.${p} -> ${out}`).toMatchObject({ k: "int" });
          expect(s.into!.p50).toBeDefined();
        } else {
          expect(target[p], `${scope}.${p}`).toBeDefined();
          expect(target[p]!.k, `${scope}.${p}`).toBe(s.k);
          if (s.k === "enum") expect(target[p]!.values, `${scope}.${p}`).toEqual(s.values);
        }
        if (s.fold === "or") expect(s.k).toBe("bool");
        if (s.fold === "sum") expect(["int", "dec"]).toContain(s.k);
      }
    }
  });

  it("folds one prop the same way in every scope of an event", () => {
    for (const event of ["flow_session", "call_session"]) {
      const seen = new Map<string, string>();
      for (const f of Object.values(facts).filter((x) => x.event === event)) {
        for (const [p, s] of Object.entries(f.props)) {
          if (seen.has(p)) expect(s.fold, `${event}.${p}`).toBe(seen.get(p));
          seen.set(p, s.fold!);
        }
      }
    }
  });

  it("lets a fact reach every event prop that is not a session-close fact, except the ones main computes", () => {
    const folded = new Set<string>();
    for (const f of Object.values(facts)) {
      for (const [p, s] of Object.entries(f.props)) (s.fold === "samples" ? Object.values(s.into!) : [p]).forEach((n) => folded.add(`${f.event}.${n}`));
    }
    const mainComputed = new Set(["duration_s", "ended_by", "acted"]);
    for (const event of ["flow_session", "call_session"]) {
      for (const p of Object.keys(events[event]!.props)) if (!mainComputed.has(p)) expect(folded.has(`${event}.${p}`), `${event}.${p}`).toBe(true);
    }
  });
});

describe("telemetry types", () => {
  it("gives web and agent literal unions and the right required props", () => {
    expectTypeOf<TelemetryEventName>().toMatchTypeOf<string>();
    expectTypeOf<"flow_session">().toMatchTypeOf<TelemetryEventName>();
    expectTypeOf<TelemetryEventProps<"tray_action">["action"]>().toEqualTypeOf<
      "open" | "new_flow" | "allow_accessibility" | "settings" | "quit"
    >();
    expectTypeOf<TelemetryEventProps<"flow_session">["turns"]>().toEqualTypeOf<number>();
    expectTypeOf<TelemetryEventProps<"flow_session">["t_see"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<FeatureCounterKey>().toEqualTypeOf<(typeof schema.counters)[number]>();
    expectTypeOf<TelemetryFactScope>().toEqualTypeOf<"flow_owner" | "call_renderer" | "agent_flow" | "agent_call">();
    expectTypeOf<TelemetryFactProps<"agent_flow">["ttft_ms"]>().toEqualTypeOf<number | undefined>();

    const ok: TelemetryEventProps<"onboarding_step"> = { step: "first_call" };
    // @ts-expect-error a step outside the closed set
    const badStep: TelemetryEventProps<"onboarding_step"> = { step: "typed the password" };
    // @ts-expect-error a required prop is missing
    const missing: TelemetryEventProps<"flow_session"> = { turns: 1 };
    // @ts-expect-error a prop the event does not have
    const extra: TelemetryEventProps<"tray_action"> = { action: "open", path: "/tmp" };
    // @ts-expect-error a fact prop the scope does not fold
    const noFact: TelemetryFactProps<"flow_owner"> = { turns: 1 };
    expect([ok, badStep, missing, extra, noFact]).toHaveLength(5);
  });
});
