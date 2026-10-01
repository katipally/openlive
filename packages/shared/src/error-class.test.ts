import { describe, expect, it } from "vitest";
import {
  AGENT_ERROR_CLASSES, API_ERROR_CLASSES, ClassedError, classifyError, ERROR_CLASSES, errorClassSchema, httpClassOf,
  SUPERVISED_CLASSES, supervisorClass, type ErrorClass,
} from "./error-class";
import { liveServerMsgSchema, flowEventSchema } from "./live-events";
import { sseEventSchema } from "./sse-events";
import { telemetrySchema } from "./telemetry-schema";

const http = (status: number, body = "") => new Error(`HTTP ${status}: ${body}`);
const net = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });

describe("the class set", () => {
  it("is exactly what brain_error may carry, so a class can never be dropped in main", () => {
    expect([...ERROR_CLASSES]).toEqual([...telemetrySchema.events.brain_error.props.class.values]);
    expect([...API_ERROR_CLASSES, ...AGENT_ERROR_CLASSES]).toEqual([...ERROR_CLASSES]);
  });

  it("is the wire `code` of every error event, optional and closed", () => {
    expect(sseEventSchema.safeParse({ type: "error", message: "x" }).success).toBe(true);
    expect(sseEventSchema.safeParse({ type: "error", message: "x", code: "auth" }).success).toBe(true);
    expect(sseEventSchema.safeParse({ type: "error", message: "x", code: "made_up" }).success).toBe(false);
    expect(flowEventSchema.safeParse({ type: "error", message: "x", aborted: false, code: "quota" }).success).toBe(true);
    expect(liveServerMsgSchema.safeParse({ t: "error", message: "x", code: "other" }).success).toBe(true);
    expect(errorClassSchema.safeParse("agent_stalled").success).toBe(true);
  });
});

describe("classifyError", () => {
  const cases: [string, unknown, ErrorClass][] = [
    ["a missing key", new Error("No API key for OpenAI. Add one in Settings."), "no_key"],
    ["a missing model", new Error("No model selected. Open Settings."), "no_model"],
    ["401", http(401, "invalid x-api-key"), "auth"],
    ["403", http(403, "forbidden"), "auth"],
    ["404", http(404, "model: nope"), "model_not_found"],
    ["400 naming a missing model", http(400, '{"error":{"message":"The model `gpt-9` does not exist"}}'), "model_not_found"],
    ["400 with any other body", http(400, "bad json"), "bad_request"],
    ["422", http(422, "unprocessable"), "bad_request"],
    ["402", http(402, "payment required"), "quota"],
    ["429 out of quota", http(429, '{"error":{"code":"insufficient_quota"}}'), "quota"],
    ["400 with a low credit balance", http(400, "Your credit balance is too low"), "quota"],
    ["429 plain", http(429, "slow down"), "rate_limited"],
    ["529 overloaded", http(529, "overloaded"), "rate_limited"],
    ["500", http(500, "oops"), "server_error"],
    ["503", http(503, ""), "server_error"],
    ["a refused connection", net("ECONNREFUSED"), "unreachable"],
    ["a name that does not resolve", net("ENOTFOUND"), "unreachable"],
    ["a reset socket", new Error("socket hang up"), "unreachable"],
    ["our own unreachable sentence", new Error("Could not reach Ollama (local) at http://x. Is it running?"), "unreachable"],
    ["a stream cut short", new Error("terminated"), "stream_error"],
    ["the stub's own words", new Error("the model stream failed"), "stream_error"],
    ["quota words without a status", new Error("You exceeded your current quota"), "quota"],
    ["auth words without a status", new Error("Incorrect authentication credentials"), "auth"],
    ["anything else", new Error("something odd"), "other"],
    ["a thrown string", "HTTP 401: nope", "auth"],
    ["nothing at all", undefined, "other"],
  ];
  it.each(cases)("%s", (_, error, expected) => {
    expect(classifyError(error)).toBe(expected);
  });

  it("reads the status from a message a caller put its own words in front of", () => {
    expect(classifyError("Live model error: HTTP 401: nope")).toBe("auth");
    expect(classifyError("the server said HTTP 503 somewhere")).toBe("server_error");
  });

  it("lets a class stamped where the error was thrown win over its words", () => {
    expect(classifyError(new ClassedError("HTTP 500: no", "agent_crashed"))).toBe("agent_crashed");
    expect(classifyError(new ClassedError("Pick a project folder", "agent_no_folder"))).toBe("agent_no_folder");
  });

  it("ignores a stamp that is not a class, and uses the fallback only when nothing matches", () => {
    expect(classifyError(Object.assign(new Error("HTTP 401: x"), { errorClass: "made_up" }))).toBe("auth");
    expect(classifyError(new Error("some agent failure"), "agent_start_failed")).toBe("agent_start_failed");
    expect(classifyError(http(500), "agent_start_failed")).toBe("server_error");
  });

  it("never returns anything outside the set, whatever it is given", () => {
    const junk: unknown[] = [null, 0, {}, [], Symbol.iterator.toString(), new Error(""), Object.create(null), { message: "HTTP 999: x" }, "HTTP 0: x"];
    for (const j of junk) expect(ERROR_CLASSES).toContain(classifyError(j));
  });
});

describe("the HTTP family", () => {
  it("is the family a class comes from, and none for what never had a status", () => {
    const family = (cls: ErrorClass) => httpClassOf(cls);
    expect(["auth", "model_not_found", "bad_request", "quota", "rate_limited"].map((c) => family(c as ErrorClass))).toEqual(Array(5).fill("4xx"));
    expect(family("server_error")).toBe("5xx");
    for (const c of ["no_key", "no_model", "unreachable", "stream_error", "other", ...AGENT_ERROR_CLASSES] as ErrorClass[]) expect(family(c), c).toBe("none");
  });

  it("agrees with the status a classified error carried", () => {
    for (const [status, family] of [[401, "4xx"], [404, "4xx"], [429, "4xx"], [400, "4xx"], [500, "5xx"], [503, "5xx"]] as const) {
      expect(httpClassOf(classifyError(http(status, "x"))), String(status)).toBe(family);
    }
  });
});

describe("supervisorClass", () => {
  it("tells no output, a stall and a crash apart", () => {
    expect(supervisorClass({ timedOut: true, sawOutput: false })).toBe("agent_no_output");
    expect(supervisorClass({ timedOut: true, sawOutput: true })).toBe("agent_stalled");
    expect(supervisorClass({ timedOut: false, sawOutput: true })).toBe("agent_crashed");
    expect(supervisorClass({ timedOut: false, sawOutput: false })).toBe("agent_crashed");
  });

  it("names only classes the supervisor reports itself", () => {
    for (const o of [{ timedOut: true, sawOutput: false }, { timedOut: true, sawOutput: true }, { timedOut: false, sawOutput: false }]) {
      expect(SUPERVISED_CLASSES.has(supervisorClass(o))).toBe(true);
    }
  });
});
