import { describe, expect, it } from "vitest";
import type { DictateSnapshot } from "@/lib/flow/types";
import { PROCESSING_MIN_MS, processingHold, stripWords } from "./strip";
import { NO_SPEECH } from "./run";

const d = (over: Partial<DictateSnapshot>): DictateSnapshot =>
  ({ phase: "idle", editing: false, partial: "", polishing: false, inserted: 0, note: "", undo: false, ready: true, ...over });

describe("a hold on a selection that heard no words", () => {
  const released = d({ phase: "processing", editing: true });
  const silent = d({ note: NO_SPEECH });

  it("never says Editing before there are words to edit with", () => {
    expect(stripWords(released, "", false)).not.toBe("Editing");
    expect(stripWords(d({ phase: "processing", editing: true, partial: "make it shorter" }), "", false)).toBe("Editing");
  });

  it("goes straight to No words heard, without waiting out the work it never did", () => {
    expect(processingHold(silent, 10)).toBe(0);
    expect(stripWords(silent, "", false)).toBe(NO_SPEECH);
  });
});

describe("processingHold", () => {
  it("keeps real work on screen long enough to read, and nothing longer", () => {
    expect(processingHold(d({ inserted: 4 }), 120)).toBe(PROCESSING_MIN_MS - 120);
    expect(processingHold(d({ inserted: 4, note: "Copied." }), 120)).toBe(PROCESSING_MIN_MS - 120);
    expect(processingHold(d({ inserted: 4 }), PROCESSING_MIN_MS + 1)).toBe(0);
    expect(processingHold(d({ phase: "processing" }), 0)).toBe(0);
  });
});

describe("stripWords", () => {
  it("names the work, then what landed", () => {
    expect(stripWords(d({ phase: "processing" }), "", false)).toBe("Cleaning up");
    expect(stripWords(d({ phase: "processing", polishing: true, partial: "hi" }), "", false)).toBe("Polishing");
    expect(stripWords(d({ phase: "processing", partial: "send it" }), "", false)).toBe("send it");
    expect(stripWords(d({ inserted: 1 }), "", false)).toBe("1 word");
    expect(stripWords(d({ inserted: 3 }), "", false)).toBe("3 words");
  });

  it("says Getting ready while the microphone wakes, and what to do between holds", () => {
    expect(stripWords(d({ ready: false }), "Hold Fn to talk", false)).toBe("Getting ready");
    expect(stripWords(d({}), "Hold Fn to talk", true)).toBe("Getting ready");
    expect(stripWords(d({}), "Hold Fn to talk", false)).toBe("Hold Fn to talk");
    expect(stripWords(d({ phase: "listening" }), "Hold Fn to talk", false)).toBe("Listening");
  });
});
