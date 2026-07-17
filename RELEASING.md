# Releasing (maintainers)

Maintainer notes — not linked from the README on purpose.

CI typechecks every push and PR. A release is one tag, no manual version bump:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The tag drives the version. CI builds the macOS (universal, signed and notarized)
and Windows installers, uploads them, and publishes the release with both downloads.

Mac signing runs when these repo secrets are set:
`MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`. Details in [`apps/desktop/README.md`](apps/desktop/README.md).
