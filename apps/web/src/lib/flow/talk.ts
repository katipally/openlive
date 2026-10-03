import type { FlowConfig, TalkMode } from "@openlive/flow-store";

/** The talk mode a config from before it was shared should get: push to talk
 *  when Chat's push-to-talk switch (ui.json) was on, else hands-free. Null when
 *  already decided. Pure. */
export function settleTalkMode(flow: Pick<FlowConfig, "talk">, chatPtt: boolean): TalkMode | null {
  if (flow.talk.mode !== null) return null;
  return chatPtt ? "ptt" : "handsFree";
}
