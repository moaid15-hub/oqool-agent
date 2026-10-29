#!/bin/sh
# Oqool Agent installer — Linux and macOS.
#   curl -fsSL https://github.com/moaid15-hub/oqool-agent/releases/latest/download/install.sh | sh
# Downloads one program for this system into ~/.oqool-agent/bin and puts it on the PATH. Nothing else is installed.
set -eu

REPO="moaid15-hub/oqool-agent"
VERSION="${OQOOL_AGENT_VERSION:-latest}"
DIR="${OQOOL_AGENT_INSTALL:-$HOME/.oqool-agent/bin}"

os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Oqool Agent: unsupported system $os (use install.ps1 on Windows)" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "Oqool Agent: unsupported processor $arch" >&2; exit 1 ;;
esac
# Apple Silicon running this shell under Rosetta still gets the native program
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi

name="oqool-agent-$os-$arch"
if [ "$VERSION" = latest ]; then
  url="https://github.com/$REPO/releases/latest/download/$name"
else
  url="https://github.com/$REPO/releases/download/$VERSION/$name"
fi

mkdir -p "$DIR"
tmp="$DIR/.oqool-agent.download"
echo "Oqool Agent: downloading $name …"
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -q --show-progress -O "$tmp" "$url"
else
  echo "Oqool Agent: needs curl or wget" >&2; exit 1
fi
# the published checksum must match before the program is put in place
sums=$(curl -fsSL "$(dirname "$url")/SHA256SUMS" 2>/dev/null || wget -qO- "$(dirname "$url")/SHA256SUMS" 2>/dev/null || true)
want=$(printf '%s\n' "$sums" | awk -v n="$name" '$2 == n { print $1 }')
if [ -n "$want" ]; then
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp" | awk '{print $1}'); else got=$(shasum -a 256 "$tmp" | awk '{print $1}'); fi
  if [ "$got" != "$want" ]; then rm -f "$tmp"; echo "Oqool Agent: checksum mismatch — not installed" >&2; exit 1; fi
fi
chmod +x "$tmp"
mv -f "$tmp" "$DIR/oqool-agent"
[ "$os" = darwin ] && xattr -d com.apple.quarantine "$DIR/oqool-agent" 2>/dev/null || true

echo "✓ Oqool Agent $("$DIR/oqool-agent" --version) → $DIR/oqool-agent"

case ":$PATH:" in
  *":$DIR:"*) ;;
  *)
    line="export PATH=\"$DIR:\$PATH\""
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      if [ -f "$rc" ] && ! grep -qs "$DIR" "$rc"; then printf '\n# Oqool Agent\n%s\n' "$line" >> "$rc"; fi
    done
    echo "  Added $DIR to PATH (open a new terminal, or run: $line)"
    ;;
esac
echo ""
# link this computer, then run in this terminal (curl | sh has no keyboard on stdin: use the terminal)
if [ -z "${OQOOL_AGENT_NO_SETUP:-}" ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
  "$DIR/oqool-agent" setup < /dev/tty > /dev/tty 2>&1 || true
else
  echo "Next:  oqool-agent setup     (link this computer, then run in this terminal)"
fi
