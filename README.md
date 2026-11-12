# gaussian_keep

<img src="brand/gauss-icon.svg" width="96" align="right" alt="">

A personal Keep-like notebook for science people, on the Linux desktop and on Android, kept in sync through a private GitHub repository.

- **Scratchbook notes**: click anywhere and write. LaTeX (`$…$`, `$$…$$`) turns into typeset math when you press Enter. Also tables, shapes and sketches, code blocks with syntax highlighting, a Greek and special-character palette, and a citation extractor (paste a link and get the reference).
- **Markdown, LaTeX, plain text and PDF notes**, with a compile tab for `.tex` files, page-turn reading and full screen.
- **Planner, organizer board, research journal and reminders** (the phone notifies you even when the app is closed).
- **Git center** on the laptop: push, pull, and review what changed.
- Material 3 design with dark and light themes.

## Phone (Android 10+)

1. Download **GaussianKeep.apk** from [Releases](../../releases). Open it and allow "Install unknown apps". If Play Protect warns about an unknown app, choose *More details → Install anyway*.
2. Everything works offline straight away, with no account.
3. To sync, open **⋮ → Settings**:
   - Create a **private** GitHub repository for your notes, with **Add a README** ticked.
   - Create a token at github.com → Settings → Developer settings → **Fine-grained tokens**. Give it access to *only that repository*, with permission **Contents: Read and write**.
   - Enter `your-username/your-repo` and the token. The token stays in the app's private storage. Never share it.

## Laptop (Linux)

```sh
git clone https://github.com/knight-dwell/gaussian-keep-app ~/.local/share/gaussian-keep
~/.local/share/gaussian-keep/install.sh      # checks packages, adds the launcher; no sudo
gaussian-keep
```

Your notes live in `~/gaussian_keep`, a git repository. To sync with the phone, point it at the same GitHub repository:

```sh
cd ~/gaussian_keep && git remote add origin git@github.com:<you>/<your-notes-repo>.git && git push -u origin main
```

After that the app syncs by itself: it checks every 20 s and pushes shortly after you stop typing. A **Sync** button is in the left rail and in Settings.

## Building the APK yourself

```sh
cd android
./setup-sdk.sh          # Android command-line tools into ~/Android/Sdk (one time, ~1 GB)
./build.sh              # → build/gaussian_keep.apk   (./build.sh install → adb install)
```

No Gradle is needed: the script runs aapt2, javac, d8 and apksigner directly. On the first build it creates your own signing key in `android/signing/`. Keep that key safe, because Android only accepts updates signed with the same key. It is git-ignored.

## Third-party pieces

- [Temml](https://temml.org) (MIT, `android/vendor/`): LaTeX → MathML on the phone.
- Material Symbols (Apache-2.0): downloaded by `install.sh`.
- Latin Modern fonts (GUST Font License): from your TeX distribution.

## License

MIT, see [LICENSE](LICENSE).
