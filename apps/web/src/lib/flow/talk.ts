import type { FlowConfig, TalkMode } from "@openlive/flow-store";
import type { FlowCloseReason } from "@openlive/shared";
import type { Dictate } from "@/lib/dictate/run";
import { DICTATE_BINDING, FLOW_BINDING, PTT_BINDING, type HookEffect } from "./bridge";

/** The talk mode a config from before it was shared should get: push to talk
 *  when Chat's push-to-talk switch (ui.json) was on, else hands-free. Null when
 *  already decided. Pure. */
export function settleTalkMode(flow: Pick<FlowConfig, "talk">, chatPtt: boolean): TalkMode | null {
  if (flow.talk.mode !== null) return null;
  return chatPtt ? "ptt" : "handsFree";
}

export interface TalkPorts {
  /** Read each time, so a change in Settings or the tray applies from the next utterance. */
  mode(): TalkMode;
  /** "Close after silence"; null never. */
  silenceMs(): number | null;
  flow: {
    isOpen(): boolean;
    /** A turn is running: silence never closes Flow under it, and its end starts the wait again. */
    busy(): boolean;
    open(): void;
    close(reason: FlowCloseReason): void;
    /** The key went down with Flow open. False when Flow cannot hear it (no microphone). */
    holdStart(): boolean;
    /** It came up; `cancel`: its words go nowhere. */
    holdEnd(cancel: boolean): Promise<void>;
  };
  dictate: Pick<Dictate, "isOpen" | "busy" | "setOpen" | "yield" | "holdStart" | "holdEnd" | "holdCancel">;
  /** Push to talk's gate on the engine, shut between holds. */
  gate(on: boolean): void;
  /** Whether the key is down, for the orb. */
  holding(on: boolean): void;
}

/**
 * Flow and Dictate as one way of talking. Each is a session opened and closed
 * by its own double tap, and only one is ever open: opening one closes the
 * other. Inside, the one talk mode applies: hands-free, the engine ends each
 * utterance at a pause; push to talk, the gate is shut and each hold of the
 * key is one utterance. Either way "Close after silence" closes the session
 * nobody has spoken to (in push to talk, held the key in) for that long.
 *
 *   closed ──double tap──▶ open ──double tap, silence or sleep──▶ closed
 *                           ├ push to talk: hold_start ▶ holding ▶ hold_end (its words) | hold_cancel (none)
 *                           └ hands-free:   speech ▶ pause ▶ its words
 */
export function createTalk(p: TalkPorts) {
  // The hold in progress, latched to whoever had it at its start, so its end
  // reaches the same one whatever opened or closed meanwhile.
  let held: "flow" | "dictate" | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopSilence = () => { clearTimeout(timer); timer = undefined; };
  /** Starts the wait over. Pushed out by every turn, every start of speech and
   *  every hold, so it only fires on a session someone has walked away from. */
  const armSilence = () => {
    stopSilence();
    const after = p.silenceMs();
    if (after === null || (!p.flow.isOpen() && !p.dictate.isOpen())) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (held || p.flow.busy()) return;
      if (p.dictate.busy()) return armSilence();
      if (p.flow.isOpen()) p.flow.close("idle");
      else if (p.dictate.isOpen()) void p.dictate.setOpen(false);
    }, after);
  };

  const holdStart = () => {
    if (held || p.mode() !== "ptt") return;
    if (p.dictate.isOpen()) { held = "dictate"; p.dictate.holdStart(); }
    else if (p.flow.isOpen() && p.flow.holdStart()) held = "flow";
    else return;
    stopSilence();
    p.holding(true);
  };
  const holdEnd = async (cancel = false) => {
    const was = held;
    if (!was) return;
    held = null;
    p.holding(false);
    if (was === "dictate") await (cancel ? p.dictate.holdCancel() : p.dictate.holdEnd());
    else await p.flow.holdEnd(cancel);
    if (!p.flow.busy()) armSilence();
  };

  const flowGesture = () => {
    if (p.flow.isOpen()) return p.flow.close("gesture");
    // Opened first, so Flow takes over the microphone Dictate leaves.
    p.flow.open();
    if (p.dictate.isOpen()) p.dictate.yield();
  };
  /** Dictate's double tap, the orb's mic button, or Flow's set_dictation tool. */
  const toggleDictate = async () => {
    if (p.dictate.isOpen()) return void (await p.dictate.setOpen(false));
    if (p.flow.isOpen()) p.flow.close("dictate_opened");
    if (await p.dictate.setOpen(true)) armSilence();
  };

  return {
    /** Every key effect the owner renderer is sent. */
    effect(e: HookEffect) {
      if (e.bindingId === PTT_BINDING) {
        if (e.kind === "hold_start") holdStart();
        else if (e.kind === "hold_end") void holdEnd();
        else if (e.kind === "hold_cancel") void holdEnd(true);
        return;
      }
      if (e.kind !== "double_tap") return;
      if (e.bindingId === DICTATE_BINDING) void toggleDictate();
      else if (e.bindingId === FLOW_BINDING) flowGesture();
    },
    toggleDictate,
    /** The settings changed: the gate follows the mode at once. A hold still
     *  down as push to talk is switched off ends as a release, its words kept,
     *  since its key is no longer watched and no release would come. */
    modeChanged() {
      if (held && p.mode() !== "ptt") void holdEnd();
      p.gate(p.mode() === "ptt");
    },
    /** Hands-free, the user started talking: the silence starts over. */
    speechStart() { if (!held && !p.flow.busy()) armSilence(); },
    armSilence,
    stopSilence,
    /** `which` closed some other way (its close button, Flow taking over): a
     *  hold in it went with it. */
    closed(which: "flow" | "dictate") {
      if (held !== which) return;
      held = null;
      p.holding(false);
    },
    /** Sleep or a lock: a hold down now never sees its release. */
    suspend() { void holdEnd(true); stopSilence(); },
    holding: () => held !== null,
  };
}
