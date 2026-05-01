#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/extensions"
TARGET_DIR="${HOME}/.local/share/gnome-shell/extensions"

mkdir -p "$TARGET_DIR"

for extension_dir in "$SOURCE_DIR"/*@*; do
  [ -d "$extension_dir" ] || continue

  uuid="$(basename "$extension_dir")"
  target="$TARGET_DIR/$uuid"

  rm -rf "$target"
  cp -a "$extension_dir" "$target"

  if [ -d "$target/schemas" ]; then
    glib-compile-schemas "$target/schemas"
  fi

  gnome-extensions enable "$uuid" || true
  echo "Installed $uuid"
done

echo "Done. Log out and log back in if an extension does not appear immediately."

