# Architecture

How OpenLive fits together, and the few decisions that shape everything else.

## The one big idea: thick client, thin server

The whole voice loop runs **on your machine, in the browser renderer**. The local
agent server is a thin driver in front of the brain you picked — an external coding
agent over ACP, or a chat-model provider. No audio ever crosses the wire.

```
┌──────────────────────────────── your machine ────────────────────────────────┐
│  renderer (apps/web)                        agent server (services/agent)    │
│                                                                              │
│  mic → VAD → STT → end-of-turn ─┐  /live WS  ┌─ LiveSession                  │
│  (Silero)(Whisper)(Smart-Turn)  ├─ text ───▶ │   ├─ AcpAgent ── stdio ──▶ your coding agent
│                                 │  +frames   │   │  (supervised)   (Claude Code / Codex / …)
│  speaker ← TTS ← sentences ─────┘◀─ reply ───┘   └─ or: provider turn loop   │
│           (Kokoro)                 (SSE text)         (BYO model key)        │
│    ▲ camera / screen frames ────────┘                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

The `/live` WebSocket carries text turns + JPEG frames up and streamed reply text
down (plus permission asks, agent metadata, and control messages — see
`packages/shared/src/live-events.ts`). The browser speaks the reply sentence by
sentence as it arrives.

## The agent registry (`packages/shared/src/agent-registry.ts`)

The **single source of agent identity**. Every agent's id, label, brand mark, ACP
adapter command, install/uninstall recipes, login/logout commands, session-store
location + parser, and credential probe lives in one table. The server driver, the
API routes, the History sidebar, and every selector read it — adding an agent is one
entry, and the whole UI (including History discovery) picks it up automatically.
Node-only helpers (credential probing, PATH widening, terminal launch) live in
`@openlive/shared/node`.

Two adapter versions are **pinned** on purpose (guarded by unit tests):
`claude-agent-acp@0.59.0` (OpenLive relies on its `_meta.claudeCode.options`
passthrough) and `hermes-agent==0.18.2`.

## Driving a coding agent over ACP (`services/agent/src/agents/`)

`AcpAgent` spawns the agent's ACP adapter as a child process and speaks JSON-RPC
over stdio ("LSP for agents"). Design points:

- **No faked capabilities.** OpenLive advertises no fs/terminal capabilities — a
  voice app isn't an editor. The agent uses its own file access and asks permission
  (via `session/request_permission`) before anything risky; the ask is spoken and
  shown as chips, answerable by voice.
- **Sessions belong to the agent.** For Claude, `_meta.claudeCode.options` rides
  `session/new`/`session/load` with `persistSession: true` (sessions land in
  `~/.claude/projects/<cwd-slug>/` where `claude --resume` finds them) and a
  system-prompt append carrying the voice-call context. `CLAUDE_CODE_ENTRYPOINT=
  claude-vscode` keeps them visible in the CLI's `/resume` picker. Other agents get
  a first-turn preamble instead.
- **Resume.** Reopening a conversation calls `session/load`; the replayed updates
  rebuild the transcript. Resume failures fall back to a fresh session silently
  (the original stays on disk and in History).
- **Models / modes / options.** The agent reports its models, modes, and other
  config options over ACP; the UI renders pickers generically and switches them
  mid-session (`set_model` / `set_mode` / `set_option`).
- **Supervision.** Every agent runs inside `AgentSupervisor`: per-turn watchdogs
  (start / first-output / stall), restart-once-then-fail, and every failure ends as
  a *spoken* one-liner + structured error — never a session stuck listening.
- **Cleanup.** Adapters spawn in their own process group so dispose kills the whole
  `npx → node → binary` tree.

History also surfaces each agent's **own** on-disk sessions
(`apps/web/src/app/api/history/agentSessions.ts` — Claude JSONL, Codex rollouts,
Cursor meta, OpenCode/Hermes read-only sqlite), deduped against OpenLive's chats,
so everything you did in the CLI shows up too.

## The voice loop (`apps/web/src/lib/live`)

One turn, end to end:

1. **VAD** (Silero) gates the mic — is anyone talking?
2. **STT** (Whisper) transcribes speech to text as it streams.
3. **End-of-turn** (Smart-Turn v3) decides you actually *finished*, not just paused.
4. The final text (plus the freshest camera/screen frame) goes out over `/live`.
5. The reply streams back as text; **TTS** (Kokoro) voices it sentence by sentence
   so speaking starts before the full answer exists.
6. **Barge-in**: start talking and it stops mid-word — the client aborts the turn
   (ACP `session/cancel` for agents) and the transcript keeps only what was spoken.

All four models run on **WebGPU via transformers.js**. They download once (~200 MB,
cached) and the worker stays warm for the tab's life.

## The built-in provider brain (`services/agent/src/live/turn-runner.ts`)

Conversations with no agent bound run on a provider turn loop: three wire adapters
in `packages/harness` (Anthropic `/messages`, OpenAI `/responses`, OpenAI
`/chat/completions`) cover every provider; a provider is a registry row. The main
voice agent does all the talking and delegates web work to a **worker subagent**
(Exa search, `fetch_url`) whose grind stays out of the main context; other tools:
`look`, `remember`, `update_todos`, clipboard/open-url via the desktop bridge.

## Packages

```
packages/shared    agent registry + node helpers, /live wire protocol, shared types
packages/harness   model adapters (Anthropic / OpenAI Responses / OpenAI Chat), model listing, effort
packages/db        JSON-file store: AES-256-GCM-encrypted keys, settings, conversations
```

`packages/db` is deliberately JSON files, not SQLite — no native modules, so
electron-builder packages the desktop app with no rebuild step.

## Quality gates

`pnpm typecheck` (all packages) and `pnpm test` (vitest, colocated `*.test.ts`) run
in CI on ubuntu + windows; the windows job also produces an unsigned installer to
prove cross-platform builds stay green.
