#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOTFILES_DIR="$ROOT_DIR/dotfiles"
TARGET_FCITX_DIR="$HOME/.config/fcitx5"
TARGET_ENV_DIR="$HOME/.config/environment.d"

PURGE_IBUS=0

for arg in "$@"; do
  case "$arg" in
    --purge-ibus)
      PURGE_IBUS=1
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

if command -v sudo >/dev/null 2>&1; then
  sudo apt update
  sudo apt install -y \
    fcitx5 \
    fcitx5-chinese-addons \
    fcitx5-pinyin \
    fcitx5-module-pinyinhelper \
    fcitx5-config-qt \
    fcitx5-frontend-all \
    im-config

  if [ "$PURGE_IBUS" -eq 1 ]; then
    sudo apt purge -y ibus ibus-data ibus-gtk ibus-gtk3 ibus-gtk4 ibus-wayland || true
  fi
else
  echo "sudo is required to install packages." >&2
  exit 1
fi

im-config -n fcitx5

mkdir -p "$TARGET_FCITX_DIR/conf" "$TARGET_ENV_DIR"
cp -a "$DOTFILES_DIR/fcitx5/." "$TARGET_FCITX_DIR/"

cat > "$TARGET_ENV_DIR/90-fcitx.conf" <<'EOF'
XMODIFIERS=@im=fcitx
GTK_IM_MODULE=fcitx
QT_IM_MODULE=fcitx
EOF

if command -v fcitx5-remote >/dev/null 2>&1; then
  fcitx5-remote -r || true
fi

echo "Fcitx5 restore completed."
echo "Log out and log back in, or reboot, to apply the full desktop input-method switch."
