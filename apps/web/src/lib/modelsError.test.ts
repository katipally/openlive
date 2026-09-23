import { describe, expect, it } from "vitest";
import { classifyModelsError } from "./modelsError";

describe("classifyModelsError", () => {
  it("names a rejected key", () => {
    expect(classifyModelsError(new Error("HTTP 401")).reason).toBe("key_rejected");
    expect(classifyModelsError(new Error("HTTP 403")).status).toBe(401);
  });
  it("names a timeout", () => {
    const e = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    expect(classifyModelsError(e)).toMatchObject({ status: 504, reason: "timeout" });
  });
  it("names other upstream errors with their code", () => {
    expect(classifyModelsError(new Error("HTTP 500"))).toMatchObject({ status: 502, reason: "upstream" });
    expect(classifyModelsError(new Error("HTTP 500")).error).toContain("500");
  });
  it("falls back to a network failure", () => {
    expect(classifyModelsError(new TypeError("fetch failed")).reason).toBe("network");
    expect(classifyModelsError(null).reason).toBe("network");
  });
});
