import { telemetrySchema } from "@openlive/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { featureUsed, tourClosed, tourRun } from "./featureUse";
import { resolveSettingsTab } from "./settingsSearch";

const install = () => {
  const bridge = { track: vi.fn(), count: vi.fn() };
  (globalThis as { window?: unknown }).window = { openlive: { telemetry: bridge } };
  return bridge;
};
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe("featureUsed", () => {
  it("counts every use and marks the first one once", () => {
    const b = install();
    featureUsed("n_settings_open");
    featureUsed("n_settings_open");
    featureUsed("n_settings_open");
    expect(b.count).toHaveBeenCalledTimes(3);
    expect(b.track).toHaveBeenCalledTimes(1);
    expect(b.track).toHaveBeenCalledWith("onboarding_step", { step: "first_settings_open" });
  });

  it("gives both resume sources and both mode switches one shared first", () => {
    const b = install();
    featureUsed("n_history_resume");
    featureUsed("n_history_resume_cli_session");
    featureUsed("n_mode_to_flow");
    featureUsed("n_mode_to_chat");
    expect(b.track.mock.calls.map((c) => c[1].step)).toEqual(["first_resume", "first_mode_switch"]);
    expect(b.count).toHaveBeenCalledTimes(4);
  });

  it("marks the first time the call setup screen opened", () => {
    const b = install();
    featureUsed("n_lobby_open");
    expect(b.track).toHaveBeenCalledWith("onboarding_step", { step: "first_lobby_open" });
  });

  it("only counts a feature that has no first step", () => {
    const b = install();
    featureUsed("n_palette_open");
    expect(b.count).toHaveBeenCalledWith("n_palette_open");
    expect(b.track).not.toHaveBeenCalled();
  });

  it("does nothing outside the desktop shell", () => {
    expect(() => featureUsed("n_camera_on")).not.toThrow();
  });
});

describe("settings page counters", () => {
  it("has one for each page Settings shows, named by the page's own id", () => {
    const prefix = "n_settings_tab_";
    const pages = telemetrySchema.counters.filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length));
    expect(pages).toHaveLength(11);
    expect(pages.map(resolveSettingsTab)).toEqual(pages);
  });
});

describe("tourClosed", () => {
  it("maps the five tour ids to their step, says how each ended and where, and sends each once", () => {
    const b = install();
    const ends = [["home", "done", 4], ["lobby", "skipped", 1], ["call", "left", 2], ["history", "done", 1], ["settings", "skipped", 3], ["home", "done", 1]] as const;
    for (const [id, exit, at] of ends) tourClosed(id, exit, at);
    expect(b.track.mock.calls.map((c) => c[1])).toEqual([
      { step: "tour_closed_home", tour_exit: "done", tour_step: 4 },
      { step: "tour_closed_lobby", tour_exit: "skipped", tour_step: 1 },
      { step: "tour_closed_call", tour_exit: "left", tour_step: 2 },
      { step: "tour_closed_history", tour_exit: "done", tour_step: 1 },
      { step: "tour_closed_settings", tour_exit: "skipped", tour_step: 3 },
    ]);
  });

  it("sends nothing for an id outside the schema", () => {
    const b = install();
    tourClosed("secret-tour", "done", 1);
    tourClosed("", "done", 1);
    expect(b.track).not.toHaveBeenCalled();
  });
});

describe("tourRun", () => {
  it("owes nothing before the tour begins, so a screen with no tour on it sends nothing when it goes", () => {
    const report = vi.fn();
    tourRun(report).end("left");
    expect(report).not.toHaveBeenCalled();
  });

  it("reports the screen going away as left, on the step the person had reached", () => {
    const report = vi.fn();
    const run = tourRun(report);
    run.begin();
    run.reach(3);
    run.end("left");
    expect(report).toHaveBeenCalledExactlyOnceWith("left", 3);
  });

  it("reports the first way a tour ends and nothing after it, so Done then the screen going does not send twice", () => {
    const report = vi.fn();
    const run = tourRun(report);
    run.begin();
    run.reach(2);
    run.end("done");
    run.reach(3);
    run.end("left");
    expect(report).toHaveBeenCalledExactlyOnceWith("done", 2);
  });

  it("keeps the step already reached when a covered tour begins again", () => {
    const report = vi.fn();
    const run = tourRun(report);
    run.begin();
    run.reach(2);
    run.begin();
    run.end("left");
    expect(report).toHaveBeenCalledWith("left", 2);
  });
});
