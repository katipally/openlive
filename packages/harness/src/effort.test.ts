import { describe, expect, it } from "vitest"
import { anthropicThinkingForm } from "./effort"

describe("anthropicThinkingForm", () => {
  it("gives the current Claude lineup adaptive thinking", () => {
    for (const id of ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) expect(anthropicThinkingForm(id)).toBe("adaptive")
  })

  it("keeps Haiku 4.5 and older free of any thinking parameter", () => {
    for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022"]) expect(anthropicThinkingForm(id)).toBe("none")
  })

  it("keeps the older generations on their own form", () => {
    expect(anthropicThinkingForm("claude-sonnet-4-6")).toBe("adaptive")
    expect(anthropicThinkingForm("claude-sonnet-4-5")).toBe("budget")
  })
})
