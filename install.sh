#!/usr/bin/env bash
# install.sh: set up the gaussian_keep laptop app for the current user (Linux).
#   ./install.sh          → checks dependencies, downloads the icon font,
#                           adds the "gaussian-keep" command and an app-menu entry
# Nothing is installed system-wide and sudo is never used: missing packages are
# only listed, with the command for your distro. Your notes live in ~/gaussian_keep
# (a git repo the app creates on first start).
set -euo pipefail
APP="$(cd "$(dirname "$(realpath "$0")")" && pwd)"

# ── dependencies ─────────────────────────────────────────────────────────────
missing=() optional=()
python3 -c 'import gi; gi.require_version("WebKit2", "4.1"); from gi.repository import WebKit2' 2>/dev/null \
  || missing+=("PyGObject + WebKitGTK 4.1")
command -v pandoc >/dev/null || missing+=(pandoc)
command -v git    >/dev/null || missing+=(git)
command -v latexmk  >/dev/null || optional+=("latexmk + TeX Live (compile .tex notes)")
command -v pdftoppm >/dev/null || optional+=("poppler (PDF page previews)")
ls /usr/share/texlive/texmf-dist/fonts/opentype/public/lm /usr/share/texmf-dist/fonts/opentype/public/lm \
   /usr/share/texmf/fonts/opentype/public/lm >/dev/null 2>&1 || optional+=("Latin Modern fonts (the book look)")

if (( ${#missing[@]} + ${#optional[@]} )); then
  (( ${#missing[@]} ))  && printf 'needed:   %s\n' "${missing[@]}"
  (( ${#optional[@]} )) && printf 'optional: %s\n' "${optional[@]}"
  echo
  if   command -v dnf    >/dev/null; then echo "Fedora:  sudo dnf install python3-gobject webkit2gtk4.1 pandoc git latexmk texlive-scheme-medium texlive-lm poppler-utils"
  elif command -v apt    >/dev/null; then echo "Debian/Ubuntu:  sudo apt install python3-gi gir1.2-webkit2-4.1 pandoc git latexmk texlive-latex-recommended fonts-lmodern poppler-utils"
  elif command -v pacman >/dev/null; then echo "Arch:  sudo pacman -S python-gobject webkit2gtk-4.1 pandoc git texlive-basic texlive-latexextra poppler"
  fi
  (( ${#missing[@]} )) && { echo "Install the needed packages, then run ./install.sh again."; exit 1; }
  echo "(the app works without the optional ones)"; echo
fi

# ── icon font (Material Symbols Rounded, Apache-2.0, from Google's repo) ─────
FONT="$HOME/.local/share/fonts/MaterialIcons/MaterialSymbolsRounded.ttf"
if [[ ! -f $FONT ]]; then
  echo "== downloading the Material Symbols icon font (~15 MB)"
  mkdir -p "$(dirname "$FONT")"
  curl -fL --progress-bar -o "$FONT.part" \
    "https://github.com/google/material-design-icons/raw/master/variablefont/MaterialSymbolsRounded%5BFILL,GRAD,opsz,wght%5D.ttf"
  mv "$FONT.part" "$FONT" && fc-cache -f >/dev/null 2>&1 || true
fi

# ── launcher + app menu entry ────────────────────────────────────────────────
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
cat > "$HOME/.local/bin/gaussian-keep" <<EOF
#!/bin/sh
# gaussian_keep: notes / planner / organizer / journal / reminders / git center ($APP)
exec python3 "$APP/app.py" "\$@"
EOF
chmod +x "$HOME/.local/bin/gaussian-keep"
cat > "$HOME/.local/share/applications/gaussian-keep.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=gaussian_keep
Comment=Notes (Markdown, LaTeX, text, PDF), planner, organizer, research journal, reminders, git center
Exec=$HOME/.local/bin/gaussian-keep
Icon=$APP/web/icon.png
Categories=Office;Utility;
StartupWMClass=GaussianKeep
EOF

echo "done: start it from your app menu, or run: gaussian-keep"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "(add ~/.local/bin to your PATH to use the command)";; esac
