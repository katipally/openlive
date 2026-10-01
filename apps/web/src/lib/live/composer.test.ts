import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENTS, MAX_IMAGE_BYTES, acceptFiles, composeMessage, filterCommands, promoteCommand, slashQuery, withSkills } from "./composer";

const CMDS = [
  { name: "review", description: "Review the current changes" },
  { name: "compact", description: "Summarise the chat to free up context", hint: "instructions" },
  { name: "init", description: "Write a CLAUDE.md for this project" },
  { name: "pr-review", description: "Review a pull request" },
  { name: "model", description: "Switch the model" },
];

describe("slashQuery", () => {
  it("opens on a leading slash word and closes at the first space", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
    expect(slashQuery("/review main")).toBeNull();
    expect(slashQuery("see /rev")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("withSkills", () => {
  const skill = (name: string, enabled = true) => ({ name, description: `the ${name} skill`, enabled });

  it("adds the enabled skills after the agent's commands, marked as skills", () => {
    const all = withSkills(CMDS, [skill("pdf"), skill("off", false)]);
    expect(all.map((c) => c.name)).toEqual([...CMDS.map((c) => c.name), "pdf"]);
    expect(all.at(-1)).toEqual({ name: "pdf", description: "the pdf skill", skill: true });
  });

  it("hides a skill an agent command shares a name with, so the command wins", () => {
    const all = withSkills(CMDS, [skill("review")]);
    expect(all).toBe(CMDS);
    expect(promoteCommand("/review main", all)?.command.skill).toBeUndefined();
  });

  it("offers skills alone when the brain has no commands, and promotes a typed one", () => {
    const all = withSkills([], [skill("pdf")]);
    expect(promoteCommand("/pdf fill this in", all)).toEqual({ command: all[0], rest: "fill this in" });
    expect(composeMessage(all[0]!, "fill this in")).toBe("/pdf fill this in");
  });
});

describe("filterCommands", () => {
  it("ranks name prefix, then name contains, then description", () => {
    expect(filterCommands(CMDS, "rev").map((c) => c.name)).toEqual(["review", "pr-review"]);
    expect(filterCommands(CMDS, "CONTEXT").map((c) => c.name)).toEqual(["compact"]);
    expect(filterCommands(CMDS, "").length).toBe(CMDS.length);
    expect(filterCommands(CMDS, "zzz")).toEqual([]);
    expect(filterCommands([], "rev")).toEqual([]);
  });
});

describe("promoteCommand", () => {
  it("turns a typed whole command and a space into a chip with its arguments", () => {
    expect(promoteCommand("/review main", CMDS)).toEqual({ command: CMDS[0], rest: "main" });
    expect(promoteCommand("/Compact ", CMDS)).toEqual({ command: CMDS[1], rest: "" });
    expect(promoteCommand("/rev main", CMDS)).toBeNull();
    expect(promoteCommand("/review", CMDS)).toBeNull();
    expect(promoteCommand("/review main", [])).toBeNull();
  });
});

describe("composeMessage", () => {
  it("sends a command as /name args and plain text trimmed", () => {
    expect(composeMessage(CMDS[0]!, "  main  ")).toBe("/review main");
    expect(composeMessage(CMDS[1]!, "")).toBe("/compact");
    expect(composeMessage(null, "  hello\nthere ")).toBe("hello\nthere");
    expect(composeMessage(null, " ", 2)).toBe("(2 images attached)");
    expect(composeMessage(null, "", 1)).toBe("(an image attached)");
    expect(composeMessage(null, "   ")).toBe("");
  });
});

describe("acceptFiles", () => {
  const img = (name: string, size = 1000) => ({ name, type: "image/png", size });
  it("takes images up to the cap and says why the rest stayed out", () => {
    const r = acceptFiles(MAX_ATTACHMENTS - 1, [img("a.png"), img("b.png"), { name: "notes.pdf", type: "application/pdf", size: 10 }, img("huge.png", MAX_IMAGE_BYTES + 1)]);
    expect(r.accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(r.rejected).toEqual([
      { name: "b.png", reason: `Up to ${MAX_ATTACHMENTS} images per message.` },
      { name: "notes.pdf", reason: "Only images can be attached." },
      { name: "huge.png", reason: "That image is too large." },
    ]);
  });
});
