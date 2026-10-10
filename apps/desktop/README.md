# OpenLive Desktop (Electron)

The low-latency OpenLive as a native app for macOS, Windows and Linux. It runs the
web + agent servers locally (warm, persistent WebSocket, no cold starts, no network
hop) and shows the UI in its own window. The voice models run in the renderer
(Chromium/WebGPU) or, for the native engines, in the local agent; the LLM call goes
out from the local agent.

Two Rust modules ship with it, built by `pnpm native:build` (and by `pnpm run pack`)
for the platform you build on, so a Rust toolchain is needed to build from source:

- `native/ol-input`, a Node addon: Flow's global key, typing, capture, OCR and input.
- `native/openlive-cu`, the computer-use helper the agent drives over a local socket:
  its own app on macOS, an executable on Windows and Linux.

Settings, keys and chats are stored as small JSON files and node:sqlite (AES-256-GCM
for keys) in `~/.openlive` (`<repo>/data` in dev). Chromium's own files stay in the
app's user-data dir.

## Develop

```bash
pnpm install
pnpm desktop:dev      # runs web + agent (dev) and opens the Electron window
```

Dev uses its own ports, `47833` (agent) / `47834` (web), so it runs alongside an
installed OpenLive.

## Build

The build bundles the Next app (standalone) + the agent (esbuild) into the app,
then runs electron-builder. The web server always uses `47824` (its origin keys
the saved settings and cached models). The agent prefers `47823` and takes any
free loopback port when that one is busy; the window is told which at launch.

```bash
pnpm desktop:build:mac    # → apps/desktop/release/OpenLive-<ver>-mac.dmg (universal)
pnpm desktop:build:win    # → NSIS installer (run this on Windows / CI)
pnpm desktop:build:linux  # → AppImage, x64 (run this on Linux / CI)
```

> Build each target on its own OS (or CI): the native modules are compiled for the
> machine that builds them. Building the NSIS installer from macOS needs extra
> tooling (wine); it's simplest to run `desktop:build:win` on a Windows machine or a
> GitHub Actions `windows-latest` runner, and `desktop:build:linux` on `ubuntu-latest`.

An unsigned build (for local testing) skips code signing:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @openlive/desktop exec electron-builder --mac dmg
```

## Sign + notarize for distribution (macOS, Apple Developer account)

electron-builder signs and notarizes automatically when your credentials are in
the environment and your **Developer ID Application** certificate is in your login
keychain. These are *your* Apple credentials, so set them yourself; they never go
in the repo.

1. **Certificate** (one-time): in Xcode → Settings → Accounts → Manage
   Certificates → **＋ → Developer ID Application**, or create it at
   developer.apple.com/account/resources/certificates and download+install it into
   your login keychain.
2. **App-specific password**: appleid.apple.com → Sign-In & Security → App-Specific
   Passwords → generate one for notarization.
3. **Team ID**: developer.apple.com/account → Membership → Team ID.
4. Notarization needs no config: electron-builder 26 notarizes whenever the
   variables in step 5 are set (`mac.notarize: false` turns it off).
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
preload.cjs     contextIsolation on; exposes only the small `openlive` bridge
                (window controls, Flow and its orb, clipboard/open-url for agent tools)
splash.html     loading screen shown until the web server answers
telemetry/      product-usage telemetry: opt-out, packaged builds only, and silent unless
                telemetry-config.json exists. `pack:telemetry` stamps that git-ignored file
                from OPENLIVE_TELEMETRY_ENDPOINT, _CLIENT_ID and _ORIGIN
resources/web   Next standalone server (dist/web): UI + /api settings routes
resources/agent agent.mjs (esbuild bundle): the /live WebSocket + tools
dist/ol-input, dist/computer-use  the staged native modules (`pack:native`)
resources/THIRD_PARTY_LICENSES.txt  the libraries inside the installer and their licenses,
                written by `pack:licenses`
```
