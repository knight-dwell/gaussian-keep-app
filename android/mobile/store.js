// store.js: the phone's copy of ~/gaussian_keep, synced with the private GitHub repo.
//
// Files live in the app's private storage (Android bridge). Saving is always local and
// instant; sync() then
//   1. downloads what changed on GitHub (the laptop pushes there),
//   2. uploads everything changed on the phone as ONE commit (Git Data API),
//   3. never loses an edit: if a file changed on both sides, the phone's version is
//      kept as "<name>-phone-conflict-<time>.<ext>" next to the laptop's.
// The GitHub token is stored in the app's private preferences only.
"use strict";

const Store = (() => {
  const SYNCED = /^(notes\/(?!\.build\/).+|journal\/.+|planner\/.+|organizer\.json|reminders\.json)$/;
  const BINARY = /\.(png|jpe?g|gif|webp|pdf)$/i;
  let index = JSON.parse(Android.getPref("index") || "{}");   // path → {sha, dirty, deleted}
  const saveIndex = () => Android.setPref("index", JSON.stringify(index));
  const cfg = () => ({ repo: Android.getPref("repo") || "", token: Android.getPref("token") || "", branch: Android.getPref("branch") || "main" });
  let syncing = null;
  const listeners = new Set();
  const emit = (state, detail) => listeners.forEach(f => f(state, detail));

  // ── local files ───────────────────────────────────────────────────────────
  function list(prefix = "") {
    return JSON.parse(Android.listFiles()).filter(p => p.startsWith(prefix) && !(index[p]?.deleted));
  }
  const read = p => Android.readFile(p);
  const readB64 = p => Android.readBase64(p);
  function json(p, fallback) { try { const t = read(p); return t == null ? fallback : JSON.parse(t); } catch { return fallback; } }
  function write(p, text) {
    if (read(p) === text) return;
    Android.writeFile(p, text); mark(p);
  }
  function writeB64(p, b64) { Android.writeBase64(p, b64); mark(p); }
  function writeJSON(p, data) { write(p, JSON.stringify(data, null, 1)); }
  function remove(p) { Android.deleteFile(p); index[p] = { ...(index[p] || {}), dirty: true, deleted: true }; saveIndex(); emit("dirty"); }
  function mark(p) { index[p] = { ...(index[p] || {}), dirty: true, deleted: false }; saveIndex(); emit("dirty"); }
  const dirtyCount = () => Object.values(index).filter(v => v.dirty).length;

  // ── GitHub REST ───────────────────────────────────────────────────────────
  async function gh(method, path, body) {
    const { repo, token } = cfg();
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) { const t = await r.text(); const e = new Error(`GitHub ${r.status}: ${(JSON.parse(t || "{}").message) || t.slice(0, 120)}`); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json();
  }
  const b64ToText = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), c => c.charCodeAt(0)));
  const textToB64 = t => { const bytes = new TextEncoder().encode(t); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

  // git's blob sha1 of local content, to tell "unchanged" from "changed" without downloading
  async function blobSha(b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const head = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(head.length + bytes.length); all.set(head); all.set(bytes, head.length);
    const h = await crypto.subtle.digest("SHA-1", all);
    return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function download(path, sha) {
    const blob = await gh("GET", `/git/blobs/${sha}`);
    Android.writeBase64(path, blob.content.replace(/\n/g, ""));
    index[path] = { sha, dirty: false, deleted: false };
  }

  function conflictName(p) {   // a name the laptop app also lists: lowercase, digits, dashes
    const m = p.match(/^(.*?)(\.[^./]+)?$/), stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-");
    return `${m[1]}-phone-conflict-${stamp}${m[2] || ""}`;
  }

  async function syncOnce() {
    const { repo, token, branch } = cfg();
    if (!repo || !token) throw new Error("Set the GitHub repo and token in Settings first");
    const ref = await gh("GET", `/git/ref/heads/${branch}`);
    const head = ref.object.sha;
    const commit = await gh("GET", `/git/commits/${head}`);
    const tree = await gh("GET", `/git/trees/${commit.tree.sha}?recursive=1`);
    const remote = {};
    tree.tree.filter(t => t.type === "blob" && SYNCED.test(t.path)).forEach(t => remote[t.path] = t.sha);

    let downloaded = 0, conflicts = 0;
    // 1. pull
    for (const [path, sha] of Object.entries(remote)) {
      const loc = index[path];
      if (loc && loc.sha === sha) continue;                          // unchanged on GitHub
      if (loc?.dirty && !loc.deleted) {
        const mine = readB64(path);
        if (mine != null && (await blobSha(mine)) === sha) { index[path] = { sha, dirty: false, deleted: false }; continue; }
        const copy = conflictName(path);                              // both changed: keep both
        Android.writeBase64(copy, mine || ""); index[copy] = { dirty: true, deleted: false }; conflicts++;
      }
      await download(path, sha); downloaded++;
    }
    for (const path of Object.keys(index)) {                          // deleted on GitHub (and untouched here)
      if (!(path in remote) && index[path].sha && !index[path].dirty) { Android.deleteFile(path); delete index[path]; }
    }
    saveIndex();

    // 2. push local changes as one commit
    const changes = Object.entries(index).filter(([p, v]) => v.dirty && SYNCED.test(p));
    if (changes.length) {
      const entries = [];
      for (const [path, v] of changes) {
        if (v.deleted) { if (path in remote) entries.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
        const b64 = readB64(path); if (b64 == null) continue;
        const blob = await gh("POST", "/git/blobs", { content: b64, encoding: "base64" });
        entries.push({ path, mode: "100644", type: "blob", sha: blob.sha });
        v.newSha = blob.sha;
      }
      if (entries.length) {
        const t = await gh("POST", "/git/trees", { base_tree: commit.tree.sha, tree: entries });
        const c = await gh("POST", "/git/commits", { message: `phone: ${changes.length} change${changes.length > 1 ? "s" : ""} (${new Date().toLocaleString()})`, tree: t.sha, parents: [head] });
        await gh("PATCH", `/git/refs/heads/${branch}`, { sha: c.sha, force: false });   // fails if the laptop pushed meanwhile → retry
      }
      for (const [path, v] of changes) {
        if (v.deleted) delete index[path]; else index[path] = { sha: v.newSha || v.sha, dirty: false, deleted: false };
      }
      saveIndex();
    }
    Android.setPref("lastSync", String(Date.now()));
    return { downloaded, uploaded: changes.length, conflicts };
  }

  async function sync() {
    if (syncing) return syncing;
    emit("syncing");
    syncing = (async () => {
      try {
        let r;
        try { r = await syncOnce(); }
        catch (e) { if (e.status === 422 || e.status === 409) r = await syncOnce(); else throw e; }   // raced with the laptop: once more
        emit("done", r); return r;
      } catch (e) { emit("error", e.message); throw e; }
      finally { syncing = null; }
    })();
    return syncing;
  }

  return { list, read, readB64, json, write, writeB64, writeJSON, remove, sync, dirtyCount, cfg, on: f => listeners.add(f), textToB64 };
})();
