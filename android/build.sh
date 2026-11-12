#!/usr/bin/env bash
# build.sh: build the gaussian_keep APK with the Android SDK tools directly (no Gradle).
#   ./build.sh            → build/gaussian_keep.apk
#   ./build.sh install    → also install it on the phone over USB (adb)
#
# The web UI is assembled from the laptop app (shared editor, Material CSS, fonts)
# plus the phone parts in mobile/. Signing key: signing/ (keep it; Android only
# accepts updates signed with the same key; it is never copied to GitHub).
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
SDK="$HOME/Android/Sdk"; BT="$SDK/build-tools/35.0.0"; JAR="$SDK/platforms/android-35/android.jar"
WEB="$HOME/.local/share/gaussian-keep/web"
VERSION_NAME="1.$(date +%y%m%d.%H%M)"; VERSION_CODE=$(( $(date +%s) / 60 - 29000000 ))

rm -rf build && mkdir -p build/{res,gen,classes,dex,assets/www/fonts,assets/www/vendor}

echo "== assets (web UI)"
W=build/assets/www
cp mobile/index.html mobile/mobile.css mobile/mobile.js mobile/store.js mobile/render.js "$W/"
cp "$WEB/app.css" "$WEB/material.css" "$WEB/scratch.js" "$W/"
cp vendor/temml.min.js "$W/vendor/"
rsvg-convert -w 192 ../brand/gauss-icon.svg -o "$W/icon.png"
# Latin Modern (texlive-lm on Fedora, fonts-lmodern on Debian/Ubuntu)
for LM in /usr/share/texlive/texmf-dist/fonts/opentype/public/lm /usr/share/texmf-dist/fonts/opentype/public/lm \
          /usr/share/texmf/fonts/opentype/public/lm; do [[ -d $LM ]] && break; done
for f in lmroman12-regular lmroman12-italic lmroman12-bold lmmonolt10-regular lmmonolt10-bold lmmonolt10-oblique \
         lmmono10-regular lmmono10-italic lmmonoproplt10-regular lmsans10-regular lmsans10-bold; do cp "$LM/$f.otf" "$W/fonts/"; done
# icons (../install.sh downloads this font); code font is optional
MS="$HOME/.local/share/fonts/MaterialIcons/MaterialSymbolsRounded.ttf"
[[ -f $MS ]] || { echo "missing $MS: run ../install.sh first (it downloads the icon font)"; exit 1; }
cp "$MS" "$W/fonts/"
JB="$HOME/.local/share/fonts/JetBrainsMonoNerd/JetBrainsMonoNerdFont-Regular.ttf"
[[ -f $JB ]] && cp "$JB" "$W/fonts/JetBrainsMono.ttf" || echo "  (no JetBrainsMono Nerd Font: code blocks use the phone's monospace)"
# the laptop CSS loads fonts from /fonts/…; on the phone they are next to the page
sed -i 's#url(/fonts/#url(fonts/#g' "$W/app.css"

echo "== resources"
"$BT/aapt2" compile --dir app/res -o build/res/res.zip
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest app/AndroidManifest.xml -R build/res/res.zip \
  --java build/gen -A build/assets --min-sdk-version 29 --target-sdk-version 35 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" --auto-add-overlay

echo "== java → dex"
javac -nowarn -Xlint:-options -source 11 -target 11 -encoding UTF-8 -classpath "$JAR" -d build/classes \
  $(find app/java build/gen -name '*.java')
"$BT/d8" --min-api 29 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
( cd build/dex && zip -q ../base.apk classes.dex )

echo "== align + sign"
mkdir -p signing && chmod 700 signing
if [[ ! -f signing/keep.jks ]]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > signing/password && chmod 600 signing/password
  keytool -genkeypair -keystore signing/keep.jks -storepass:file signing/password -keypass:file signing/password \
    -alias keep -keyalg RSA -keysize 3072 -validity 20000 -dname "CN=gaussian_keep" >/dev/null 2>&1
  chmod 600 signing/keep.jks
fi
"$BT/zipalign" -f -p 4 build/base.apk build/aligned.apk
"$BT/apksigner" sign --ks signing/keep.jks --ks-pass file:signing/password --ks-key-alias keep \
  --out build/gaussian_keep.apk build/aligned.apk
"$BT/apksigner" verify build/gaussian_keep.apk
echo "built build/gaussian_keep.apk  ($(du -h build/gaussian_keep.apk | cut -f1), version $VERSION_NAME)"

if [[ ${1:-} == install ]]; then
  "$SDK/platform-tools/adb" install -r build/gaussian_keep.apk
fi
