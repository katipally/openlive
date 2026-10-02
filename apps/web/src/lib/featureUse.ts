import { telemetrySchema, type FeatureCounterKey, type TelemetryEventProps } from "@openlive/shared";
import { telemetry } from "./telemetry";

type Step = TelemetryEventProps<"onboarding_step">["step"];

// The one-time step a counted feature also marks: the counter is ongoing use,
// the step is when the person first found it.
const FIRST: Partial<Record<FeatureCounterKey, Step>> = {
  n_settings_open: "first_settings_open",
  n_settings_search: "first_settings_search",
  n_palette_run: "first_palette_use",
  n_history_open: "first_history_open",
  n_history_resume: "first_resume",
  n_history_resume_cli_session: "first_resume",
  n_flow_history_open: "first_flow_history_open",
  n_flow_carry_on: "first_carry_on",
  n_lobby_open: "first_lobby_open",
  n_camera_on: "first_camera_on",
  n_screen_on: "first_screen_share",
  n_typed_msg: "first_typed_message",
  n_ptt_toggle: "first_ptt_on",
  n_mode_to_flow: "first_mode_switch",
  n_mode_to_chat: "first_mode_switch",
  n_mode_to_dictate: "first_mode_switch",
  n_shortcuts_sheet: "first_shortcuts_sheet",
};

/** A counted feature was used: one count, and its first-time step (the wrapper sends that once). */
export function featureUsed(key: FeatureCounterKey): void {
  telemetry.count(key);
  const step = FIRST[key];
  if (step) telemetry.track("onboarding_step", { step });
}

const STEPS = telemetrySchema.events.onboarding_step.props.step.values;

export type TourExit = NonNullable<TelemetryEventProps<"onboarding_step">["tour_exit"]>;

/** A spotlight tour ended: how, and on which step (1 is the first). A tour id outside the schema's five sends nothing. */
export function tourClosed(id: string, exit: TourExit, reached: number): void {
  const step = STEPS.find((s) => s === `tour_closed_${id}`);
  if (step) telemetry.track("onboarding_step", { step, tour_exit: exit, tour_step: reached });
}

/**
 * The one exit a tour that has begun still owes, and how far it got. A tour ends
 * when the person finishes it, skips it, or the screen goes from under it; the first
 * of those reports and the rest find nothing owed.
 */
export function tourRun(report: (exit: TourExit, reached: number) => void) {
  let reached = 0;
  return {
    begin() { reached ||= 1; },
    reach(step: number) { if (reached) reached = step; },
    end(exit: TourExit) {
      if (!reached) return;
      const at = reached;
      reached = 0;
      report(exit, at);
    },
  };
}
