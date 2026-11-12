#!/usr/bin/env bash
# setup-sdk.sh: one-time setup to build the gaussian_keep Android app (APK) on this laptop.
#
# Downloads (from Google, into ~/Android/Sdk, no sudo needed):
#   * Android command-line tools (sdkmanager)
#   * platform android-35 (Android 15), build-tools 35.0.0 (aapt2, d8, apksigner, zipalign)
#   * platform-tools (adb: installs the APK on your Pixel over USB)
# and from npm:
#   * temml (MIT licence): turns LaTeX into MathML so the phone typesets maths offline
#
# sdkmanager shows Google's Android SDK licence: read it and answer y to accept.
set -euo pipefail
SDK="$HOME/Android/Sdk"
APP="$HOME/.local/share/gaussian-keep/android"
TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"

mkdir -p "$SDK/cmdline-tools" "$APP/vendor"
if [[ ! -x $SDK/cmdline-tools/latest/bin/sdkmanager ]]; then
  echo "== downloading Android command-line tools"
  tmp=$(mktemp -d)
  curl -fL --progress-bar -o "$tmp/tools.zip" "https://dl.google.com/android/repository/$TOOLS_ZIP"
  unzip -q "$tmp/tools.zip" -d "$tmp"
  rm -rf "$SDK/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -rf "$tmp"
fi

echo "== installing platform, build tools and adb (read the licence, answer y)"
"$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" \
  "platforms;android-35" "build-tools;35.0.0" "platform-tools"

echo "== fetching temml (LaTeX → MathML for the phone)"
tmp=$(mktemp -d)
( cd "$tmp" && npm pack temml --silent >/dev/null && tar xzf temml-*.tgz )
cp "$tmp/package/dist/temml.min.js" "$APP/vendor/temml.min.js"
cp "$tmp/package/LICENSE" "$APP/vendor/temml-LICENSE" 2>/dev/null || true
rm -rf "$tmp"

echo
echo "Done. SDK in $SDK"
ls "$SDK/build-tools" "$SDK/platforms"
echo "Tell Claude: sdk ready"
