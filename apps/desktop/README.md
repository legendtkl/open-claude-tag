# OpenClaudeTag Console Desktop

This package wraps the existing `apps/console` admin UI in a macOS Electron app.

## Packaging Boundary

The desktop package does not bundle the console source tree. Root desktop
commands build `apps/console` with `VITE_OPEN_TAG_DESKTOP=1` and
`electron-builder` only includes:

- `apps/desktop/dist/**` for the Electron main process and preload bridge
- `apps/console/dist/**` copied into app resources as `console/`

Build through the root desktop commands so the packaged app contains only the
compiled desktop operator console assets.

## Local Commands

From the repository root:

```bash
pnpm build:desktop
pnpm dev:desktop
pnpm start:desktop:local
pnpm dist:desktop:mac
```

`pnpm start:desktop:local` starts the local API/Worker with `pnpm start:local`,
then launches the Electron desktop app against `http://127.0.0.1:3000`. The
backend keeps running after the app window closes; stop it with `pnpm stop:local`.

`pnpm dist:desktop:mac` creates local development DMG/ZIP artifacts under
`apps/desktop/release/`. These may be unsigned or ad-hoc signed when no Apple
Developer ID certificate is available.

For local development against a Vite dev server, set:

```bash
OPEN_TAG_CONSOLE_DEV_SERVER_URL=http://127.0.0.1:5173 pnpm --filter @open-tag/desktop dev
```

## API Server Configuration

The app proxies `/admin/*` and `/health` from the packaged console to the
OpenClaudeTag API. Resolution order:

1. `OPEN_TAG_API_URL`
2. `API_URL`
3. Saved desktop Settings value
4. Baked-in default: the central server `http://your-server.example.com:3000`
   (override this default tier only with `OPEN_TAG_DESKTOP_DEFAULT_API_URL`)

A freshly installed app connects to the central server out of the box. Users can
change the API URL in the desktop app under Settings. The saved value lives in
Electron's user data directory as `desktop-config.json`. The
`OPEN_TAG_API_URL` / `API_URL` environment variables intentionally win over the
default and saved Settings, so local developer commands (e.g.
`start:desktop:local`, which pins `OPEN_TAG_API_URL=http://127.0.0.1:3000`) can
force the app back to a local API. `OPEN_TAG_DESKTOP_DEFAULT_API_URL` instead
repoints just the baked-in default — useful for moving to a registered service
domain later without editing source.

## User Installation

For a normal user-facing release, distribute the signed and notarized DMG from
the GitHub Release created by the desktop release workflow.

1. Download the matching macOS artifact:
   - `arm64` for Apple Silicon Macs
   - `x64` for Intel Macs
2. Open the DMG.
3. Drag `OpenClaudeTag Console.app` into `Applications`.
4. Launch the app. It connects to the central server
   (`http://your-server.example.com:3000`) by default.
5. Only if your deployment lives elsewhere, open Settings and set the OpenClaudeTag
   API URL.

If testing a local unsigned build, macOS Gatekeeper may require a control-click
Open flow. Do not distribute unsigned local builds to end users.

## Signed Release

The GitHub Actions workflow `.github/workflows/desktop-release.yml` builds both
macOS architectures, signs the app, notarizes it, staples the notarization ticket,
uploads artifacts, and creates a GitHub Release.

Required repository secrets:

| Secret                        | Value                                                      |
| ----------------------------- | ---------------------------------------------------------- |
| `MAC_CSC_LINK`                | Base64-encoded `.p12` Developer ID Application certificate |
| `MAC_CSC_KEY_PASSWORD`        | Password for the `.p12` certificate                        |
| `APPLE_ID`                    | Apple Developer account email                              |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for notarization                     |
| `APPLE_TEAM_ID`               | Apple Developer Team ID                                    |

Manual signed build from the repository root:

```bash
CSC_LINK=<base64-p12-or-path> \
CSC_KEY_PASSWORD=<certificate-password> \
APPLE_ID=<apple-id-email> \
APPLE_APP_SPECIFIC_PASSWORD=<app-specific-password> \
APPLE_TEAM_ID=<team-id> \
pnpm dist:desktop:mac:signed
```

Post-build verification:

```bash
codesign --verify --deep --strict --verbose=2 "apps/desktop/release/mac-arm64/OpenClaudeTag Console.app"
xcrun stapler validate "apps/desktop/release/mac-arm64/OpenClaudeTag Console.app"
spctl --assess --verbose --type exec "apps/desktop/release/mac-arm64/OpenClaudeTag Console.app"
```
