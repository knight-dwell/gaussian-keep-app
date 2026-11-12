"""gaussian_keep backend: storage, compiling, git, and a small local HTTP API.

Everything lives as plain files in ~/gaussian_keep (a git repo), so it can be
synced with `git pull/push` (and later by the phone app through the same API):

  notes/<id>.md | .tex | .txt     notes (the file IS the note)
  notes/<id>.pdf                  imported PDFs
  notes/assets/                   images inserted into notes
  notes/.build/                   compile output (git-ignored)
  journal/YYYY-MM-DD.md           research journal, one file per day
  planner/YYYY-MM-DD.json         daily planner
  organizer.json                  Keep-style cards (checklists, quick notes)
  reminders.json                  shared with the eww calendar + notifications
  settings.json                   theme / font / spacing

The HTTP server only listens on 127.0.0.1 and every /api request must carry
the random token the app window was started with.
"""
import datetime as dt
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import scratch_backend as sb

HOME = os.path.expanduser("~")
ROOT = os.path.join(HOME, "gaussian_keep")
NOTES = os.path.join(ROOT, "notes")
ASSETS = os.path.join(NOTES, "assets")
BUILD = os.path.join(NOTES, ".build")
TRASH = os.path.join(ROOT, ".trash")
JOURNAL = os.path.join(ROOT, "journal")
PLANNER = os.path.join(ROOT, "planner")
ORGANIZER = os.path.join(ROOT, "organizer.json")
REMINDERS = os.path.join(ROOT, "reminders.json")
SETTINGS = os.path.join(ROOT, "settings.json")
OLD_REMINDERS = os.path.join(HOME, ".local/share/reminders/reminders.json")
REMINDER_PID = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "eww-reminders.pid")
WEB = os.path.join(os.path.dirname(os.path.realpath(__file__)), "web")
LM_FONTS = next((d for d in ("/usr/share/texlive/texmf-dist/fonts/opentype/public/lm",   # Fedora (texlive-lm)
                              "/usr/share/texmf-dist/fonts/opentype/public/lm",            # Arch
                              "/usr/share/texmf/fonts/opentype/public/lm")                  # Debian/Ubuntu (fonts-lmodern)
                 if os.path.isdir(d)), "/usr/share/texlive/texmf-dist/fonts/opentype/public/lm")
NOTE_TYPES = {"keep": "Scratchbook", "md": "Markdown", "tex": "LaTeX", "txt": "Text", "pdf": "PDF"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

DEFAULT_SETTINGS = {"theme": "dark", "editorFont": "LM Mono Light", "fontSize": 17,
                    "lineHeight": 1.75, "previewFont": "LM Roman", "pageFlip": True}

GITIGNORE = "notes/.build/\n.trash/\n*.aux\n*.log\n*.fls\n*.fdb_latexmk\n*.synctex.gz\n"


# ── helpers ──────────────────────────────────────────────────────────────────
def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, path)


def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or "note"
    base, n = s, 2
    while any(os.path.exists(os.path.join(NOTES, f"{s}.{e}")) for e in NOTE_TYPES):
        s, n = f"{base}-{n}", n + 1
    return s


def run(cmd, cwd=None, timeout=120, inp=None):
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, input=inp)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"
    except FileNotFoundError as e:
        return 127, "", str(e)


def init_store():
    for d in (NOTES, ASSETS, BUILD, TRASH, JOURNAL, PLANNER):
        os.makedirs(d, exist_ok=True)
    if not os.path.exists(os.path.join(ROOT, ".git")):
        run(["git", "init", "-q", "-b", "main"], cwd=ROOT)
    gi = os.path.join(ROOT, ".gitignore")
    if not os.path.exists(gi):
        write_text(gi, GITIGNORE)
    # reminders move here (so they sync with everything else); the old file is
    # kept as a backup copy, the calendar reads the new location
    if not os.path.exists(REMINDERS):
        write_json(REMINDERS, read_json(OLD_REMINDERS, []))
    if not os.path.exists(ORGANIZER):
        write_json(ORGANIZER, {"cards": [
            {"id": "welcome", "title": "Welcome to gaussian_keep", "color": "blue", "pinned": True,
             "text": "Quick notes and checklists live here, like Keep.\nNotes (Markdown / LaTeX / text / PDF) are in the Notes tab.",
             "items": [{"text": "Write the first research journal entry", "done": False},
                       {"text": "Try Ctrl+Enter in a LaTeX note", "done": False}], "updated": time.time()}]})
    if not any(f.rsplit(".", 1)[-1] in NOTE_TYPES for f in os.listdir(NOTES)):
        write_text(os.path.join(NOTES, "scratch.md"), WELCOME_MD)
        write_text(os.path.join(NOTES, "latex-sample.tex"), WELCOME_TEX)
    if run(["git", "-C", ROOT, "rev-parse", "--verify", "HEAD"])[0] != 0:   # first commit
        run(["git", "-C", ROOT, "add", "-A"])
        run(["git", "-C", ROOT, "commit", "-q", "-m", "gaussian_keep: start"])


WELCOME_MD = """# Scratch book

Write anything here: *Markdown* with math, tables and images.

Inline math $E = \\hbar \\omega$ and display math:

$$ \\hat H \\,|\\psi\\rangle = E\\,|\\psi\\rangle $$

| quantity | symbol | value |
|---|---|---|
| Planck | $h$ | $6.626\\times10^{-34}$ J s |
| Boltzmann | $k_B$ | $1.381\\times10^{-23}$ J/K |

Press **Ctrl+Enter** to render the preview, **→ / ←** (Alt) to turn the page.
"""

WELCOME_TEX = r"""\documentclass[11pt]{article}
\usepackage{amsmath,booktabs,graphicx}
\usepackage[margin=2.2cm]{geometry}
\title{A LaTeX note}
\author{gaussian\_knight}
\begin{document}
\maketitle
The time-independent Schr\"odinger equation
\begin{equation}
  \hat H \, |\psi\rangle = E \, |\psi\rangle .
\end{equation}

\begin{table}[h]\centering
\begin{tabular}{lcc}\toprule
 state & $n$ & $E_n/\hbar\omega$ \\ \midrule
 ground & 0 & 1/2 \\
 first  & 1 & 3/2 \\ \bottomrule
\end{tabular}
\end{table}
\end{document}
"""


# ── notes ────────────────────────────────────────────────────────────────────
def note_path(nid):
    if not ID_RE.match(nid or ""):
        raise ValueError("bad note id")
    for ext in NOTE_TYPES:
        p = os.path.join(NOTES, f"{nid}.{ext}")
        if os.path.exists(p):
            return p, ext
    raise FileNotFoundError(nid)


def note_title(path, ext):
    if ext == "pdf":
        return os.path.basename(path)[:-4].replace("-", " ")
    if ext == "keep":
        return read_json(path, {}).get("title") or "Untitled"
    try:
        head = open(path, encoding="utf-8", errors="replace").read(4000)
    except OSError:
        head = ""
    m = (re.search(r"^#\s+(.+)$", head, re.M) if ext == "md"
         else re.search(r"\\title\{([^}]*)\}", head) if ext == "tex" else None)
    if m:
        return m.group(1).strip()
    first = next((l.strip() for l in head.splitlines() if l.strip()), "")
    return first[:60] or os.path.basename(path).rsplit(".", 1)[0]


def list_notes():
    out = []
    for name in os.listdir(NOTES):
        nid, _, ext = name.rpartition(".")
        if ext in NOTE_TYPES and ID_RE.match(nid):
            p = os.path.join(NOTES, name)
            out.append({"id": nid, "type": ext, "kind": NOTE_TYPES[ext], "title": note_title(p, ext),
                        "updated": os.path.getmtime(p)})
    return sorted(out, key=lambda n: -n["updated"])


def compile_note(nid):
    path, ext = note_path(nid)
    os.makedirs(BUILD, exist_ok=True)
    if ext == "md":
        code, out, err = run(["pandoc", "-f", "markdown+tex_math_dollars+pipe_tables", "-t", "html5",
                              "--mathml", "--resource-path", NOTES, path], cwd=NOTES)
        return {"kind": "html", "html": out, "ok": code == 0, "log": err}
    if ext == "txt":
        return {"kind": "text", "text": open(path, encoding="utf-8", errors="replace").read(), "ok": True}
    if ext == "tex":
        outdir = os.path.join(BUILD, nid)
        os.makedirs(outdir, exist_ok=True)
        code, out, err = run(["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error",
                              "-file-line-error", f"-outdir={outdir}", path], cwd=NOTES, timeout=180)
        pdf = os.path.join(outdir, nid + ".pdf")
        log = out + err
        errors = [l for l in log.splitlines() if re.search(r":\d+: |^! ", l)][:12]
        if code != 0 or not os.path.exists(pdf):
            return {"kind": "pdf", "ok": False, "pages": [], "log": "\n".join(errors) or log[-3000:]}
        return {"kind": "pdf", "ok": True, "pages": render_pdf(pdf, nid), "log": "\n".join(errors),
                "pdf": f"/files/notes/.build/{nid}/{nid}.pdf"}
    if ext == "pdf":
        return {"kind": "pdf", "ok": True, "pages": render_pdf(path, nid), "log": ""}
    if ext == "keep":   # the scratchbook is its own preview; compile = typeset PDF
        res = export_pdf(nid)
        pdf = os.path.join(BUILD, nid + ".pdf")
        pages = render_pdf(pdf, nid + "-keep") if res["ok"] and os.path.exists(pdf) else []
        return {"kind": "pdf", "ok": res["ok"], "pages": pages, "pdf": res.get("pdf"), "log": res.get("log", "")}
    return {"kind": "text", "text": "", "ok": False}


def render_pdf(pdf, nid):
    """PDF pages → PNGs (cached by mtime), returned as /files URLs."""
    outdir = os.path.join(BUILD, nid, "pages")
    stamp = os.path.join(outdir, ".stamp")
    mtime = str(os.path.getmtime(pdf))
    if not (os.path.exists(stamp) and open(stamp).read() == mtime):
        shutil.rmtree(outdir, ignore_errors=True)
        os.makedirs(outdir)
        run(["pdftoppm", "-png", "-r", "110", "-l", "60", pdf, os.path.join(outdir, "p")], timeout=120)
        write_text(stamp, mtime)
    pages = sorted(f for f in os.listdir(outdir) if f.endswith(".png"))
    return [f"/files/notes/.build/{nid}/pages/{p}?v={mtime}" for p in pages]


def export_pdf(nid):
    """Markdown/text → PDF with pandoc + xelatex (Latin Modern), next to the note."""
    path, ext = note_path(nid)
    if ext == "tex":
        res = compile_note(nid)
        return {"ok": res["ok"], "pdf": res.get("pdf"), "log": res.get("log", "")}
    if ext == "keep":   # scratchbook → Markdown (sketches → PNG) → PDF
        md = sb.to_markdown(read_json(path, {}), nid, BUILD)
        path = os.path.join(BUILD, nid + ".md")
        write_text(path, md)
        ext = "md"
    if ext not in ("md", "txt"):
        return {"ok": False, "log": "nothing to export"}
    out = os.path.join(BUILD, nid + ".pdf")
    code, _, err = run(["pandoc", path, "-o", out, "--pdf-engine=xelatex", "-V", "geometry:margin=2.2cm",
                        "--resource-path", NOTES] + (["-f", "markdown"] if ext == "md" else ["-f", "markdown-auto_identifiers"]),
                       cwd=NOTES, timeout=180)
    return {"ok": code == 0, "pdf": f"/files/notes/.build/{nid}.pdf", "log": err[-2000:]}


# ── reminders (shared with the eww calendar) ────────────────────────────────
def poke_calendar():
    try:
        os.kill(int(open(REMINDER_PID).read()), signal.SIGUSR1)
    except (OSError, ValueError):
        pass


def save_reminders(items):
    write_json(REMINDERS, items)
    poke_calendar()


# ── git ──────────────────────────────────────────────────────────────────────
def repos():
    rs = [{"name": "gaussian_keep", "path": ROOT}]
    for name, p in (("config-dump (system configs)", os.path.join(HOME, "config-dump")),):
        if os.path.isdir(os.path.join(p, ".git")):
            rs.append({"name": name, "path": p, "system": True})
    for p in read_json(SETTINGS, {}).get("extraRepos", []):
        if os.path.isdir(os.path.join(p, ".git")):
            rs.append({"name": os.path.basename(p), "path": p})
    return rs


def repo_path(idx):
    rs = repos()
    return rs[int(idx)]["path"]


def git_status(path):
    _, branch, _ = run(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"])
    _, porcelain, _ = run(["git", "-C", path, "status", "--porcelain=v1", "-uall"])
    _, log, _ = run(["git", "-C", path, "log", "-8", "--pretty=format:%h%x09%ar%x09%s"])
    _, remote, _ = run(["git", "-C", path, "remote", "get-url", "origin"])
    _, ab, _ = run(["git", "-C", path, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
    files = []
    for line in porcelain.splitlines():
        files.append({"status": line[:2].strip() or "?", "path": line[3:]})
    ahead, behind = (ab.split() + ["0", "0"])[:2] if ab.strip() else ("0", "0")
    return {"branch": branch.strip(), "files": files, "remote": remote.strip(),
            "log": [dict(zip(("hash", "when", "msg"), l.split("\t", 2))) for l in log.splitlines()],
            "ahead": int(ahead), "behind": int(behind)}


def git_diff(path, file):
    if file.startswith("/") or ".." in file.split("/"):
        raise ValueError("bad path")
    _, d, _ = run(["git", "-C", path, "diff", "HEAD", "--", file])
    if not d.strip():  # untracked: show as new file
        full = os.path.join(path, file)
        if os.path.isfile(full) and os.path.getsize(full) < 200_000:
            try:
                d = "".join("+" + l for l in open(full, encoding="utf-8", errors="replace"))
            except OSError:
                d = ""
    return d[:300_000]


# ── HTTP API ─────────────────────────────────────────────────────────────────
class Api(BaseHTTPRequestHandler):
    token = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # responses
    def send(self, code, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else (json.dumps(body, ensure_ascii=False) if ctype == "application/json" else body).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text", "application/json")) else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in getattr(self, "extra_headers", []):
            self.send_header(k, v)
        self.extra_headers = []
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.headers.get("Content-Type", "").startswith("application/json"):
            return json.loads(raw or b"{}")
        return raw

    def authorized(self):
        """Token in a header (API calls) or in the HttpOnly cookie the start
        page set (needed for <img> tags, which can't send headers)."""
        tok = self.headers.get("X-Keep-Token", "")
        for part in self.headers.get("Cookie", "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "keep":
                tok = tok or v
        return bool(tok) and secrets.compare_digest(tok, self.token)

    # static files
    def static(self, base, rel):
        full = os.path.realpath(os.path.join(base, rel))
        if not full.startswith(os.path.realpath(base) + os.sep) or not os.path.isfile(full):
            return self.send(404, {"error": "not found"})
        ext = full.rsplit(".", 1)[-1].lower()
        ctype = {"html": "text/html", "css": "text/css", "js": "application/javascript", "png": "image/png",
                 "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "svg": "image/svg+xml",
                 "webp": "image/webp", "pdf": "application/pdf", "otf": "font/otf", "ttf": "font/ttf"}.get(ext, "application/octet-stream")
        with open(full, "rb") as fh:
            self.send(200, fh.read(), ctype)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        if p == "/" or p == "/index.html":
            # the window opens /?token=…; that sets the session cookie
            given = urllib.parse.parse_qs(u.query).get("token", [""])[0]
            if not (given and secrets.compare_digest(given, self.token)) and not self.authorized():
                return self.send(403, {"error": "bad token"})
            self.extra_headers = [("Set-Cookie", f"keep={self.token}; HttpOnly; SameSite=Strict; Path=/")]
            return self.static(WEB, "index.html")
        if p.startswith("/web/"):
            return self.static(WEB, p[5:])
        if p.startswith("/fonts/"):
            return self.static(LM_FONTS, p[7:])
        if p.startswith("/files/"):
            if not self.authorized():
                return self.send(403, {"error": "bad token"})
            return self.static(ROOT, urllib.parse.unquote(p[7:]))
        return self.api("GET", p, urllib.parse.parse_qs(u.query))

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        self.api("POST", u.path, urllib.parse.parse_qs(u.query))

    def do_PUT(self):
        self.api("PUT", urllib.parse.urlparse(self.path).path, {})

    def do_DELETE(self):
        self.api("DELETE", urllib.parse.urlparse(self.path).path, {})

    def api(self, method, path, q):
        if not path.startswith("/api/"):
            return self.send(404, {"error": "not found"})
        if not self.authorized():
            return self.send(403, {"error": "bad token"})
        parts = path[5:].strip("/").split("/")
        if method in ("PUT", "POST", "DELETE") and parts[0] not in ("render", "sync"):
            LAST_WRITE[0] = time.time()
        try:
            res = route(method, parts, q, self.body if method in ("POST", "PUT") else (lambda: None), self.headers)
            self.send(200, res)
        except FileNotFoundError:
            self.send(404, {"error": "not found"})
        except ValueError as e:
            self.send(400, {"error": str(e)})
        except Exception as e:  # keep the server alive, report to the UI
            self.send(500, {"error": f"{type(e).__name__}: {e}"})


def route(method, parts, q, body, headers):
    head = parts[0]
    # settings
    if head == "settings":
        if method == "PUT":
            s = dict(DEFAULT_SETTINGS, **read_json(SETTINGS, {}))
            s.update({k: v for k, v in body().items() if k in DEFAULT_SETTINGS or k == "extraRepos"})
            write_json(SETTINGS, s)
        return dict(DEFAULT_SETTINGS, **read_json(SETTINGS, {}))
    # notes
    if head == "notes":
        if len(parts) == 1:
            if method == "POST":
                b = body()
                ext = b.get("type", "md")
                if ext not in ("keep", "md", "tex", "txt"):
                    raise ValueError("type")
                title = (b.get("title") or "Untitled").strip()
                nid = slugify(title)
                tmpl = {"keep": json.dumps({"title": title, "blocks": [{"type": "text", "md": ""}]}, ensure_ascii=False),
                        "md": f"# {title}\n\n", "txt": f"{title}\n\n",
                        "tex": WELCOME_TEX.replace("A LaTeX note", title.replace("_", r"\_"))}[ext]
                write_text(os.path.join(NOTES, f"{nid}.{ext}"), tmpl)
                return {"id": nid, "type": ext}
            return list_notes()
        nid = parts[1]
        if len(parts) == 3 and parts[2] == "compile":
            return compile_note(nid)
        if len(parts) == 3 and parts[2] == "export":
            return export_pdf(nid)
        if len(parts) == 3 and parts[2] == "markdown":
            path, ext = note_path(nid)
            return {"markdown": sb.to_markdown(read_json(path, {}), nid, BUILD) if ext == "keep"
                    else open(path, encoding="utf-8").read()}
        path, ext = note_path(nid)
        if method == "GET":
            text = "" if ext == "pdf" else open(path, encoding="utf-8", errors="replace").read()
            return {"id": nid, "type": ext, "title": note_title(path, ext), "content": text}
        if method == "PUT":
            if ext == "pdf":
                raise ValueError("PDF notes are read-only")
            content = body().get("content", "")
            if ext == "keep":
                json.loads(content)   # refuse to save a broken scratchbook
            write_text(path, content)
            return {"ok": True, "title": note_title(path, ext), "updated": time.time()}
        if method == "DELETE":
            os.makedirs(TRASH, exist_ok=True)
            shutil.move(path, os.path.join(TRASH, f"{int(time.time())}-{os.path.basename(path)}"))
            return {"ok": True}
    if head == "upload" and method == "POST":
        # images for notes, PDFs as notes. Filename from header, content = raw body
        name = os.path.basename(urllib.parse.unquote(headers.get("X-Filename", "file")))
        stem, _, ext = name.rpartition(".")
        ext = ext.lower()
        data = body()
        if ext == "pdf":
            nid = slugify(stem or "document")
            with open(os.path.join(NOTES, f"{nid}.pdf"), "wb") as fh:
                fh.write(data)
            return {"id": nid, "type": "pdf"}
        if ext not in ("png", "jpg", "jpeg", "gif", "svg", "webp"):
            raise ValueError("unsupported file type")
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", stem)[:50] or "image"
        fname = f"{safe}-{secrets.token_hex(3)}.{ext}"
        with open(os.path.join(ASSETS, fname), "wb") as fh:
            fh.write(data)
        return {"path": f"assets/{fname}", "url": f"/files/notes/assets/{fname}"}
    # sync status for the UI (it polls this and reloads when rev changes); POST = sync now
    if head == "sync":
        if method == "POST":
            autosync()
        ab = run(["git", "-C", ROOT, "rev-list", "--left-right", "--count", "HEAD...refs/remotes/origin/main"])[1].split()
        return dict(SYNC_STATE, ahead=int(ab[0]) if ab else 0, behind=int(ab[1]) if len(ab) > 1 else 0,
                    remote=run(["git", "-C", ROOT, "remote", "get-url", "origin"])[0] == 0)
    # scratchbook helpers
    if head == "render" and method == "POST":
        items = body().get("items", [])[:400]
        return {"html": sb.render(items)}
    if head == "cite":
        ref = sb.cite(q.get("url", [""])[0])
        return dict(ref, formatted=sb.format_ref(ref))
    if head == "palette":
        p = read_json(os.path.expanduser("~/.config/theme/generated/palette.json"), {})
        return {k: v for k, v in p.items() if isinstance(v, str) and v.startswith("#")}
    # journal
    if head == "journal":
        if len(parts) == 1:
            return sorted((f[:-3] for f in os.listdir(JOURNAL) if DATE_RE.match(f[:-3])), reverse=True)
        d = parts[1]
        if not DATE_RE.match(d):
            raise ValueError("date")
        p = os.path.join(JOURNAL, d + ".md")
        if method == "PUT":
            text = body().get("content", "")
            if text.strip():
                write_text(p, text)
            elif os.path.exists(p):
                os.remove(p)
            return {"ok": True}
        if len(parts) == 3 and parts[2] == "render":
            code, out, _ = run(["pandoc", "-f", "markdown+tex_math_dollars", "-t", "html5", "--mathml"],
                               inp=open(p, encoding="utf-8").read() if os.path.exists(p) else "")
            return {"html": out}
        return {"date": d, "content": open(p, encoding="utf-8").read() if os.path.exists(p) else ""}
    # planner
    if head == "planner":
        d = parts[1]
        if not DATE_RE.match(d):
            raise ValueError("date")
        p = os.path.join(PLANNER, d + ".json")
        if method == "PUT":
            write_json(p, body())
            return {"ok": True}
        return read_json(p, {"focus": "", "tasks": [], "blocks": [], "notes": ""})
    # organizer (Keep cards)
    if head == "organizer":
        if method == "PUT":
            write_json(ORGANIZER, body())
            return {"ok": True}
        return read_json(ORGANIZER, {"cards": []})
    # reminders
    if head == "reminders":
        items = read_json(REMINDERS, [])
        if method == "GET":
            return sorted(items, key=lambda r: (r["date"], r["time"]))
        if method == "POST":
            b = body()
            if not DATE_RE.match(b.get("date", "")) or not re.match(r"^\d{2}:\d{2}$", b.get("time", "")):
                raise ValueError("date/time")
            r = {"id": secrets.token_hex(4), "date": b["date"], "time": b["time"],
                 "text": " ".join(str(b.get("text", "")).split())[:300], "fired": False}
            when = dt.datetime.strptime(r["date"] + " " + r["time"], "%Y-%m-%d %H:%M")
            r["fired"] = when < dt.datetime.now() - dt.timedelta(minutes=1)
            items.append(r)
            save_reminders(items)
            return r
        rid = parts[1] if len(parts) > 1 else ""
        if method == "PUT":
            b = body()
            for r in items:
                if r["id"] == rid:
                    for k in ("date", "time", "text", "fired"):
                        if k in b:
                            r[k] = b[k]
                    if {"date", "time"} & set(b) and "fired" not in b:
                        when = dt.datetime.strptime(r["date"] + " " + r["time"], "%Y-%m-%d %H:%M")
                        r["fired"] = when < dt.datetime.now() - dt.timedelta(minutes=1)
            save_reminders(items)
            return {"ok": True}
        if method == "DELETE":
            save_reminders([r for r in items if r["id"] != rid])
            return {"ok": True}
    # git center
    if head == "git":
        if len(parts) == 1:
            return [dict(r, idx=i) for i, r in enumerate(repos())]
        path = repo_path(parts[1])
        action = parts[2] if len(parts) > 2 else "status"
        if action == "status":
            return git_status(path)
        if action == "diff":
            return {"diff": git_diff(path, q.get("file", [""])[0])}
        if action == "commit":
            msg = body().get("message", "").strip() or f"keep: {dt.datetime.now():%Y-%m-%d %H:%M}"
            run(["git", "-C", path, "add", "-A"])
            code, out, err = run(["git", "-C", path, "commit", "-m", msg])
            return {"ok": code == 0, "log": (out + err)[-3000:]}
        if action in ("pull", "push"):
            cmd = ["git", "-C", path, "pull", "--rebase", "--autostash"] if action == "pull" else ["git", "-C", path, "push"]
            code, out, err = run(cmd, timeout=120)
            if action == "push" and "no upstream" in err:
                code, out, err = run(["git", "-C", path, "push", "-u", "origin", "HEAD"], timeout=120)
            return {"ok": code == 0, "log": (out + err)[-3000:]}
        if action == "refresh-system":
            # re-copy the system configs into ~/config-dump so `status` shows what changed
            script = os.path.join(HOME, ".config-backups/make-config-dump.sh")
            code, out, err = run(["bash", script], timeout=300)
            return {"ok": code == 0, "log": (out + err)[-3000:]}
    raise FileNotFoundError("/".join(parts))


def autocommit():
    """Version history for free: commit whatever changed (notes, planner, …)."""
    code, out, _ = run(["git", "-C", ROOT, "status", "--porcelain"])
    if code == 0 and out.strip():
        run(["git", "-C", ROOT, "add", "-A"])
        run(["git", "-C", ROOT, "commit", "-q", "-m", f"keep: autosave {dt.datetime.now():%Y-%m-%d %H:%M}"])


SYNC_STATE = {"last": None, "ok": True, "log": "", "rev": 0}   # rev: +1 every time a pull brought changes
LAST_WRITE = [0.0]          # last time the UI saved something (push only after a short pause)
SYNC_LOCK = threading.Lock()


def autosync():
    """Commit, then exchange with the GitHub remote (the phone syncs through it).
    A conflict is never merged automatically: the rebase is undone, your commits stay
    local, and the Git tab shows it (ahead/behind) until it is resolved."""
    with SYNC_LOCK:
        _autosync()


def _autosync():
    autocommit()
    if run(["git", "-C", ROOT, "remote", "get-url", "origin"])[0] != 0:
        return
    before = run(["git", "-C", ROOT, "rev-parse", "HEAD"])[1]
    code, out, err = run(["git", "-C", ROOT, "pull", "--rebase", "--autostash", "-q", "origin", "main"], timeout=90)
    if code != 0:
        run(["git", "-C", ROOT, "rebase", "--abort"])
        SYNC_STATE.update(last=time.time(), ok=False, log=(out + err)[-1500:])
        return
    if run(["git", "-C", ROOT, "rev-parse", "HEAD"])[1] != before:
        SYNC_STATE["rev"] += 1               # the UI reloads what it shows
        poke_calendar()                      # reminders may have come from the phone
    code, out, err = run(["git", "-C", ROOT, "push", "-q", "origin", "HEAD:main"], timeout=90)
    SYNC_STATE.update(last=time.time(), ok=code == 0, log=(out + err)[-1500:])


def sync_needed():
    """Cheap check (no download): did the phone push, or is there laptop work to push?"""
    if run(["git", "-C", ROOT, "remote", "get-url", "origin"])[0] != 0:
        return False
    code, out, _ = run(["git", "-C", ROOT, "ls-remote", "origin", "refs/heads/main"], timeout=20)
    remote = out.split()[0] if code == 0 and out.strip() else ""
    known = run(["git", "-C", ROOT, "rev-parse", "refs/remotes/origin/main"])[1].strip()
    if remote and remote != known:
        return True                                          # new commits on GitHub
    if time.time() - LAST_WRITE[0] < 15:
        return False                                         # still typing: wait for a pause
    dirty = run(["git", "-C", ROOT, "status", "--porcelain"])[1].strip()
    ahead = run(["git", "-C", ROOT, "rev-list", "--count", "refs/remotes/origin/main..HEAD"])[1].strip()
    return bool(dirty) or ahead not in ("", "0")


def _autocommit_loop():
    while True:
        time.sleep(20)
        try:
            if sync_needed():
                autosync()
        except Exception:
            pass


def serve():
    """Start the API on a free localhost port; returns (port, token)."""
    init_store()
    try:
        autosync()                   # snapshot + exchange with the phone (via GitHub)
    except Exception:
        pass
    threading.Thread(target=_autocommit_loop, daemon=True).start()
    Api.token = secrets.token_urlsafe(24)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Api)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1], Api.token
