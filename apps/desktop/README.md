# OpenLive Desktop (Electron)

The low-latency OpenLive as a native macOS + Windows app. It runs the web + agent
servers locally (warm, persistent WebSocket — no cold starts, no network hop) and
shows the UI in its own window. The voice models run in the renderer
(Chromium/WebGPU); the LLM call goes out from the local agent.

No native modules: settings/keys/chats are stored as small JSON files
(AES-256-GCM for keys) under the app's user-data dir, so packaging is clean.

## Develop

```bash
pnpm install
pnpm desktop:dev      # runs web + agent (dev) and opens the Electron window
```

## Build

The build bundles the Next app (standalone) + the agent (esbuild) into the app,
then runs electron-builder. Ports are the uncommon `47823` (agent) / `47824`
(web) to avoid collisions on users' machines.

```bash
pnpm desktop:build:mac    # → apps/desktop/release/OpenLive-<ver>-arm64.dmg (+ x64)
pnpm desktop:build:win    # → NSIS installer (run this on Windows / CI)
```

> Build the Windows target on Windows (or CI). Building the NSIS installer from
> macOS needs extra tooling (wine); it's simplest to run `desktop:build:win` on a
> Windows machine or a GitHub Actions `windows-latest` runner.

An unsigned build (for local testing) — skips code signing:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @openlive/desktop exec electron-builder --mac dmg
```

## Sign + notarize for distribution (macOS, Apple Developer account)

electron-builder signs and notarizes automatically when your credentials are in
the environment and your **Developer ID Application** certificate is in your login
keychain. These are *your* Apple credentials — set them yourself; they never go
in the repo.

1. **Certificate** (one-time): in Xcode → Settings → Accounts → Manage
   Certificates → **＋ → Developer ID Application**, or create it at
   developer.apple.com/account/resources/certificates and download+install it into
   your login keychain.
2. **App-specific password**: appleid.apple.com → Sign-In & Security → App-Specific
   Passwords → generate one for notarization.
3. **Team ID**: developer.apple.com/account → Membership → Team ID.
4. Enable notarization — add to `electron-builder.yml` under `mac:`
   ```yaml
   mac:
     notarize:
       teamId: "YOURTEAMID"
   ```
5. Build with the creds exported:
   ```bash
   export APPLE_ID="you@example.com"
   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   export APPLE_TEAM_ID="YOURTEAMID"
   pnpm desktop:build:mac
   ```
   electron-builder signs with the Developer ID cert (auto-discovered), staples the
   notarization ticket, and produces a distributable, Gatekeeper-clean `.dmg`.

### Windows signing (optional)
NSIS installers run unsigned (users see a SmartScreen warning). To sign, provide a
code-signing cert via electron-builder's `win.certificateFile` +
`CSC_KEY_PASSWORD`, or an Azure Trusted Signing / EV cert. Not required to ship.

## What's in the package

```
main.cjs        Electron main: spawns the servers, media permissions, window, splash
preload.cjs     locked-down (contextIsolation, nothing exposed)
splash.html     loading screen shown until the web server answers
resources/web   Next standalone server (dist/web) — UI + /api settings routes
resources/agent agent.mjs (esbuild bundle) — the /live WebSocket + tools
```
