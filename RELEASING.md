# Releasing (maintainers)

Maintainer notes, not linked from the README on purpose.

CI typechecks every push and PR. A release is one tag:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The tag drives the version the installers carry: CI stamps it into
`apps/desktop/package.json` before building. Keep the `version` in every
workspace `package.json` equal to the release in the release PR, so a checkout
reads the same number; `Cargo.toml` files are not part of that.

CI builds the macOS (universal, signed and notarized), Windows, and Linux
(unsigned AppImage) installers on their native runners, uploads them, and
publishes the release with all three downloads.

Mac signing runs when these repo secrets are set:
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`. Details in [`apps/desktop/README.md`](apps/desktop/README.md).

## Usage telemetry

A release reports anonymous usage only when three repository variables are set. If
any of them is unset, the release is silent: nothing is stamped and the app sends
nothing.

```
 repo variables ─▶ release.yml: Stamp telemetry settings ─▶ pack:telemetry ─▶ telemetry-config.json ─▶ packaged app
                                                                              (git-ignored)             no file, no telemetry
```

Set them as repository **variables**, not secrets, under Settings > Secrets and
variables > Actions > Variables (or `gh variable set NAME`). They are public values:
the app ships them.

| Variable | What it holds | Where you find it |
|---|---|---|
| `OPENLIVE_TELEMETRY_ENDPOINT` | The public root of the ingest host: `https`, no path. The app adds `/api/track` itself. | The address the analytics server answers on from the internet. |
| `OPENLIVE_TELEMETRY_CLIENT_ID` | The ingest project's public client ID. | The analytics dashboard, Settings > Clients. |
| `OPENLIVE_TELEMETRY_ORIGIN` | The origin the ingest project allows. The app sends it as the `Origin` header. | The same client's allowed origins (CORS) in the dashboard. |

- **All three or none.** With one missing or empty, `pack:telemetry` writes no
  `apps/desktop/telemetry-config.json` and the step log says the build sends no
  telemetry. With all three set but unusable (an endpoint that is not `https` or
  loopback `http`, an origin that is not a URL, a client ID that is not a UUID) the
  step fails and the release stops. It never prints the values.
- **Local builds never report.** A local build has none of the variables, so it stamps
  nothing (and removes a stale file from an earlier stamp). `pnpm desktop:dev` never
  reports either: only a packaged app with a stamped file does. Do not export the
  three variables on a machine that builds test installers.
- **CI builds are silent.** `ci.yml` builds installers without the variables.
- **Check a release.** In a downloaded build, Settings > Privacy shows the switch only
  when the build can send. Otherwise it says the build does not send usage data.

What the app sends is listed in [`docs/TELEMETRY.md`](docs/TELEMETRY.md), and the privacy policy is [`docs/PRIVACY.md`](docs/PRIVACY.md).
