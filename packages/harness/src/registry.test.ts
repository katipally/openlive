import { describe, expect, it } from "vitest"
import {
  BUILTIN_PROVIDERS, DEFAULT_OLLAMA_URL, isUnreachable, normalizeOllamaUrl, resolveApiMode, unreachableMessage, withSettings,
  type StoredProvider,
} from "./registry"

const ollama = BUILTIN_PROVIDERS.find((p) => p.id === "ollama")!

describe("normalizeOllamaUrl", () => {
  it("keeps the server root and tolerates what people paste", () => {
    expect(normalizeOllamaUrl("http://localhost:11434")).toBe("http://localhost:11434")
    expect(normalizeOllamaUrl("  http://localhost:11434/  ")).toBe("http://localhost:11434")
    expect(normalizeOllamaUrl("http://192.168.1.20:11434/v1")).toBe("http://192.168.1.20:11434")
    expect(normalizeOllamaUrl("https://gpu.example.com/ollama/api/")).toBe("https://gpu.example.com/ollama")
    expect(normalizeOllamaUrl("HTTP://Box.Local:8080")).toBe("http://box.local:8080")
  })

  it("refuses anything that is not a plain http(s) address", () => {
    for (const bad of ["", "   ", "localhost:11434", "ftp://host", "file:///etc/passwd", "http://", "http://h?x=1", "http://user:pw@h", "not a url"]) {
      expect(normalizeOllamaUrl(bad), bad).toBeNull()
    }
  })
})

describe("withSettings", () => {
  it("points local Ollama at the configured server, and falls back to the default", () => {
    expect(withSettings(ollama, { ollamaBaseUrl: "http://10.0.0.5:11434/" }).baseURL).toBe("http://10.0.0.5:11434/v1")
    expect(withSettings(ollama, {}).baseURL).toBe(`${DEFAULT_OLLAMA_URL}/v1`)
    expect(withSettings(ollama, { ollamaBaseUrl: "garbage" }).baseURL).toBe(`${DEFAULT_OLLAMA_URL}/v1`)
  })

  it("leaves every other provider alone, Ollama Cloud included", () => {
    const cloud = BUILTIN_PROVIDERS.find((p) => p.id === "ollama-cloud")!
    expect(withSettings(cloud, { ollamaBaseUrl: "http://10.0.0.5:11434" })).toBe(cloud)
  })
})

describe("resolveApiMode", () => {
  const row = (kind: string, hasKey: boolean, isDefault = false): StoredProvider => ({ kind, hasKey, isDefault })

  it("honours the chosen provider without a key instead of falling back to one that has a key", () => {
    const r = resolveApiMode({ liveProviderId: "openai" }, [row("anthropic", true, true), row("openai", false)])
    expect(r.provider.id).toBe("openai")
    expect(r.ready).toBe(false)
  })

  it("is ready for a keyed or local provider, and for a key only the environment has", () => {
    expect(resolveApiMode({ liveProviderId: "anthropic" }, [row("anthropic", true)]).ready).toBe(true)
    expect(resolveApiMode({ liveProviderId: "ollama" }, []).ready).toBe(true)
    expect(resolveApiMode({ liveProviderId: "groq" }, [], (p) => p.id === "groq").ready).toBe(true)
  })

  it("uses the default row, then the first, when nothing was chosen", () => {
    expect(resolveApiMode({}, [row("groq", true), row("xai", true, true)]).provider.id).toBe("xai")
    expect(resolveApiMode({}, [row("groq", true)]).provider.id).toBe("groq")
    expect(resolveApiMode({}, []).ready).toBe(false)
  })

  it("runs the chosen model, and a recommendation when none is chosen", () => {
    expect(resolveApiMode({ liveProviderId: "ollama", liveModel: "qwen3:8b" }, []).model).toBe("qwen3:8b")
    expect(resolveApiMode({ liveProviderId: "anthropic" }, []).model).toBe("claude-haiku-4-5")
    expect(resolveApiMode({ liveModel: "stray" }, [row("groq", true)]).model).not.toBe("stray")
  })

  it("reads effort, with auto and junk as undefined", () => {
    expect(resolveApiMode({ liveEffort: "high" }, []).effort).toBe("high")
    expect(resolveApiMode({ liveEffort: "auto" }, []).effort).toBeUndefined()
    expect(resolveApiMode({ liveEffort: "ludicrous" }, []).effort).toBeUndefined()
  })

  it("carries the configured Ollama address", () => {
    expect(resolveApiMode({ liveProviderId: "ollama", ollamaBaseUrl: "http://nas:11434" }, []).provider.baseURL).toBe("http://nas:11434/v1")
  })
})

describe("unreachable", () => {
  it("recognises a request that never arrived, and names where it was sent", () => {
    expect(isUnreachable(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }))).toBe(true)
    expect(isUnreachable(new Error("HTTP 401: nope"))).toBe(false)
    const local = withSettings(ollama, { ollamaBaseUrl: "http://nas:11434" })
    expect(unreachableMessage(local)).toBe("Could not reach Ollama (local) at http://nas:11434. Is it running?")
  })
})
