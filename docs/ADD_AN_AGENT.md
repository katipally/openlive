# Add an agent

OpenLive drives a coding agent over the [Agent Client Protocol](https://agentclientprotocol.com)
(ACP): it starts the agent's ACP adapter as a child process and talks JSON-RPC over
stdio. If your agent speaks ACP, plugging it in is one registry entry, and the
selectors, Settings > Agents, History, voice and tools all pick it up.

This is for developers who fork OpenLive. If you only want to run a different
adapter for an agent that is already listed, skip to
[Without forking](#without-forking).

```
 your agent ──ACP adapter (stdio)──▶ OpenLive ──▶ voice, vision, computer use
                                        │
                                        └── MCP `openlive` server: the tools come for free
```

## 0. What you need first

An adapter: a command that speaks ACP on stdin and stdout. Some agents ship it
(`opencode acp`, `gemini --acp`, `copilot --acp`, `hermes acp`, `kiro-cli acp`,
`agent acp` for Cursor), some have a bridge package (Claude Code and Codex use
`npx` adapters, Pi uses `pi-acp`). Run it and send an ACP `initialize`; the
`agentCapabilities` it answers decide the choices below:

| Capability it reports | Decides |
|---|---|
| `loadSession` | whether an old session can be reopened (`resumeAcrossRestart`) |
| `sessionCapabilities.list` | whether History can ask it for its sessions |
| `promptCapabilities.image` | whether camera and screen frames can ride a turn |
| `mcpCapabilities.http` | whether it can take the `openlive` tools (see [step 6](#6-how-the-agent-gets-openlives-tools)) |

## 1. Register the id

In `packages/shared/src/agent-registry.ts`, add the id to `AGENT_IDS`. Its order
is the order every list shows.

```ts
export const AGENT_IDS = ["claude-code", "codex", ..., "pi", "myagent"] as const;
```

`AgentId`, the selectors and `AGENT_LIST` follow from it. `AGENT_REGISTRY` is a
`Record<AgentId, AgentDef>`, so TypeScript will not compile until the entry in
step 2 exists.

## 2. Fill in the `AgentDef`

Add an entry to `AGENT_REGISTRY`. Copy the nearest existing one (`opencode` for a
plain npm CLI, `cursor` for a script install) and change it.

| Field | What it is |
|---|---|
| `id`, `label` | The id (same as in `AGENT_IDS`) and the name people see. |
| `brand` | `{ color }` for a colored mark, or `{ letter }` for a letter badge. |
| `logoSrc` | The mark's file under `/agents`, see [step 3](#3-the-brand-mark). |
| `adapter` | `{ command, args }`: what OpenLive spawns. Pin a package version (`pkg@1.2.3`) when it runs through `npx`, so a release cannot change the call under users. |
| `bins` | Binary names whose presence on `PATH` means "installed". Any one counts. |
| `install`, `uninstall` | Recipes: `npm` (a global npm package), or `posixShell` and `winShell`. Install must work headlessly. Leave it out if there is no scripted install. |
| `login`, `winLogin`, `logout` | The CLI's sign-in command, which needs a terminal, so Settings opens one. `logout` absent means no Sign out. |
| `wizard` | `true` when sign-in is a setup wizard that can be left half done (the UI then says "Finish setup"). |
| `sessionsDir` | Where the agent keeps its sessions, `~`-relative. |
| `sessionParser` | How History reads them: see [step 4](#4-history-optional). |
| `externalDeletable` | `true` only when a session is a plain file OpenLive may delete. Never for a live database. |
| `credProbe` | A read-only check that it is signed in, without starting it: a file, a JSON key, a line in a file, a macOS keychain item, or `anyOf` several. |
| `startHint` | One line shown when the agent dies before the handshake. |
| `acp.resumeAcrossRestart` | `true` if `loadSession` really works after the agent restarts. |
| `acp.preamble` | `"firstMessage"` for almost everyone. `"systemPrompt"` is only for an adapter that takes a system-prompt append, as Claude's does. |
| `acp.mcp` | `"native"` if the agent reads the project's `.mcp.json` itself, `"passthrough"` if OpenLive should pass it. |
| `acp.terminal` | `true` to let OpenLive host the agent's commands, so output streams into the tool card and cancel kills the process tree. |
| `acp.mcpBridge`, `acp.env`, `acp.toolless` | Optional. `env` is extra environment for the adapter. `toolless` is how the agent starts with no tools, which Dictate's AI polish needs; without it, polish keeps the tools and refuses every ask. `mcpBridge` exists for Pi's adapter, which drops MCP servers. |

`installedProbe` is an optional extra check on top of `bins`; no entry sets it today.

## 3. The brand mark

- Put the SVG at `apps/web/public/agents/<id>.svg` and point `logoSrc` at
  `/agents/<id>.svg`.
- The app draws the mark from `apps/web/src/components/live/AgentIcon.tsx`, so it
  can take the theme's color. Add the mark's single path (24 by 24 viewBox) to
  `PATHS` there. Without one, the icon is a circle with `brand.letter`.
- The registry test needs either `logoSrc` or `brand.letter`, so an agent always
  renders something.

## 4. History (optional)

History lists the agent's own sessions next to OpenLive's. Pick one:

- **The agent supports ACP `session/list`.** Set `sessionParser: "none"`. History
  asks the agent through the agent service (`GET /agents/sessions`).
- **It keeps sessions in files.** Add a format. In
  `apps/web/src/app/api/history/agentSessions.ts`, write `mySessions():
  ExternalSession[]` returning `{ id, title, updatedAt, cwd }` for the newest
  sessions, add its name to the `sessionParser` union in the registry, and add it
  to `PARSERS` (a `Record` keyed on that union, so TypeScript reminds you). Read
  only the head of each file, as the other parsers do, and skip what you cannot
  read. If the sessions are plain files, `deleteExternalSession` in the same file
  is where a Delete is made to work.
- **Neither.** `"none"`: only sessions started in OpenLive show up.

## 5. Telemetry id (optional)

Anonymous usage counts carry the agent as a fixed id from a closed list. An id
outside it is dropped from the event, and nothing breaks, so a private fork can
skip this. To count the agent, add the id to `AGENT_IDS` in
`packages/shared/src/telemetry-schema.ts`, regenerate the copy the desktop main
process reads with `node apps/desktop/scripts/gen-telemetry-schema.cjs`, and add
it to the coding agent ids in [TELEMETRY.md](TELEMETRY.md#coding-agent-ids).

## 6. How the agent gets OpenLive's tools

You write nothing for this. OpenLive starts a loopback MCP server named `openlive`
per session and passes it in `mcpServers` when the session starts; your agent
sees the same tools OpenLive's own brain has (files, web research, memory,
reminders, and on the desktop app the computer-use helper). The agent is told the
tool names in its preamble. Details are in
[ARCHITECTURE.md](ARCHITECTURE.md#how-an-agent-gets-openlives-tools).

One condition: the adapter must accept an http MCP server. An adapter that
reports `mcpCapabilities.http: false` is not sent it, and works as a voice
interface without the extra tools. An adapter that drops `mcpServers` quietly
(Pi's does) needs a bridge of its own, which is what `mcpBridge` is for.

## 7. Test it

```bash
pnpm test         # includes the registry test: every entry complete, pins intact
pnpm typecheck
pnpm desktop:dev  # runs the app
```

Then, in the app:

1. **Settings > Agents.** Your agent is listed. Installed, signed in and its
   version read correctly. If not, the `bins`, `credProbe` or `startHint` is off.
2. **Chat.** Pick it in **Who answers**, choose a project folder, press Start.
   It should connect without the start hint.
3. **Talk to it.** It should answer out loud, and ask permission aloud before a
   command or an edit.
4. **Ask it to list its `openlive` tools.** If it names them, the MCP server
   reached it.
5. **History.** A session you made in its CLI shows up under **All**, and
   Resume replays it.

## Without forking

The `acpCommand:<id>` setting replaces the adapter command of an agent that
already has an entry, for people who do not fork. It is for when an adapter's
package is renamed or you want a different build of one, for example
`acpCommand:codex` set to `npx -y @agentclientprotocol/codex-acp@2.1.1`. It cannot
add a tenth agent: the id must be one in `AGENT_IDS`.

Set it by adding the key to `settings.json` in the OpenLive home (`~/.openlive`, or
`%USERPROFILE%\.openlive` on Windows), and it applies to the next session that
starts. The value is split on spaces and, outside Windows, run with no shell, so keep it
to a program and plain arguments. The settings API refuses anything else (only letters,
digits and `@ . _ : / + = [ ] ~ -`, 512 characters at most, so no quotes, pipes or
other shell characters), and you should hold a hand edit to the same rule.
