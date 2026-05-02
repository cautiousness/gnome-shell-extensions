# GNOME Shell Extensions

Personal GNOME Shell extensions for daily Linux desktop use.

## Extensions

- `vpn-status@codex.local`: top bar VPN/proxy status indicator for Clash, OpenVPN, WireGuard, TUN interfaces, NetworkManager VPNs, and proxy country flag detection.
- `clipboard-indicator@tudmotu.com`: Clipboard Indicator extension from Tudmotu, with a local patch that deduplicates clipboard history when loading and writing cache entries.
- `openweather-extension@penguin-teal.github.io`: OpenWeather Refined fork configured for QWeather/JWT, Chinese panel text, and local icon/theme fixes.

## Install

Run:

```bash
./scripts/install.sh
```

The installer copies all directories under `extensions/` to:

```text
~/.local/share/gnome-shell/extensions/
```

It also compiles schemas when an extension has a `schemas/` directory, then enables each installed extension.

After installation, log out and log back in if GNOME Shell does not show the extension immediately.

## Add Another Extension

Create a new directory under `extensions/`. The directory name must match the `uuid` field in that extension's `metadata.json`.

Example:

```text
extensions/example@codex.local/metadata.json
```

```json
{
  "uuid": "example@codex.local",
  "name": "Example",
  "shell-version": ["46"]
}
```

## Notes

- GNOME Shell extension source code is usually JavaScript plus metadata and schema XML files.
- `schemas/gschemas.compiled` is generated locally and is intentionally not committed.
- GNOME Shell versions can require changes to `metadata.json` and extension APIs.
- `clipboard-indicator@tudmotu.com` is a third-party extension. Keep its upstream URL in `metadata.json` and review local patches before updating it from upstream.
