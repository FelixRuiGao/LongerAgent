#!/bin/sh
set -eu

REPO="${FERMI_REPO:-FelixRuiGao/Fermi}"
INSTALL_DIR="${FERMI_INSTALL_DIR:-$HOME/.fermi/bin}"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) echo "fermi: unsupported OS: $os" >&2; exit 1 ;;
esac

case "$arch" in
  arm64|aarch64) machine="arm64" ;;
  x86_64|amd64) machine="x64" ;;
  *) echo "fermi: unsupported architecture: $arch" >&2; exit 1 ;;
esac

asset="fermi-${platform}-${machine}.tar.gz"
if [ "${FERMI_VERSION:-}" ]; then
  url="https://github.com/${REPO}/releases/download/${FERMI_VERSION}/${asset}"
else
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
fi

tmp="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT INT TERM

echo "Downloading $url"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$tmp/$asset"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp/$asset" "$url"
else
  echo "fermi: curl or wget is required" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
tar -xzf "$tmp/$asset" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/fermi" 2>/dev/null || true

path_line='export PATH="$HOME/.fermi/bin:$PATH"'
profile=""
if [ -n "${SHELL:-}" ]; then
  case "$(basename "$SHELL")" in
    zsh) profile="$HOME/.zshrc" ;;
    bash) profile="$HOME/.bashrc" ;;
  esac
fi
[ -n "$profile" ] || profile="$HOME/.profile"

if [ "$INSTALL_DIR" = "$HOME/.fermi/bin" ] && ! printf '%s' ":$PATH:" | grep -q ":$HOME/.fermi/bin:"; then
  touch "$profile"
  if ! grep -Fq "$path_line" "$profile"; then
    printf '\n%s\n' "$path_line" >> "$profile"
    echo "Added ~/.fermi/bin to PATH in $profile"
  fi
fi

echo "Installed fermi to $INSTALL_DIR/fermi"
