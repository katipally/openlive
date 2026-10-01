import { telemetrySchema } from "@openlive/shared";

// A closed id from a string the app holds: the schema's own member when there
// is one, undefined otherwise, so a value outside the set never reaches an event.
const member = <T extends string>(values: readonly T[]) => (v: string | null | undefined): T | undefined => values.find((x) => x === v);

const { events } = telemetrySchema;
export const brainIdOf = member(events.lobby_blocked.props.brain_id.values);
export const sttFamilyOf = member(events.voice_models_result.props.stt_family.values);
export const ttsFamilyOf = member(events.voice_models_result.props.tts_family.values);
export const failureCodeOf = member(events.flow_failure_card.props.code.values);
