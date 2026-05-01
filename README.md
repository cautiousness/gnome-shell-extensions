# GNOME Shell Extensions

Personal GNOME Shell extensions for daily Linux desktop use.

## Extensions

- `vpn-status@codex.local`: top bar VPN/proxy status indicator for Clash, OpenVPN, WireGuard, TUN interfaces, NetworkManager VPNs, and proxy country flag detection.

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

