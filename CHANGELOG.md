# Changelog

All notable changes to OpenLive are recorded here. The newest version is on top.
Releases before 0.1.9 predate this file — see the
[GitHub releases](https://github.com/katipally/openlive/releases) for those.

## [0.1.9] - 2026-07-11

### Added
- **A dozen more model providers.** Alongside Anthropic, OpenAI, and MiniMax,
  OpenLive now speaks to Google Gemini, xAI Grok, DeepSeek, Mistral, Groq, Cerebras,
  Together, Fireworks, OpenRouter, Perplexity, and Ollama (local and cloud). Paste a
  key and the model list loads live from the provider — nothing hardcoded.
- **Separate vision model (optional).** If your live model can't see, point OpenLive
  at a dedicated vision model under Settings → Vision model. Camera and screen frames
  are described by that model and handed to your live model, so a fast text-only
  model can still watch your screen. Leave it off and the live model sees for itself.
- **Real vision capability in the picker.** The `vision` badge now comes from actual
  provider / models.dev metadata rather than a name guess, and the picker warns when
  the selected model can't accept images.

### Changed
- A third wire adapter (OpenAI Chat Completions) joins the Anthropic and OpenAI
  Responses adapters, so most hosted providers work through one code path.
- Snapshot model defaults refreshed to current IDs (e.g. DeepSeek V4, Grok 4.5),
  preferring fast vision-capable models for the voice + camera loop.

[0.1.9]: https://github.com/katipally/openlive/releases/tag/v0.1.9
