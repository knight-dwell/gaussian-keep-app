// gaussian_keep on the phone: tabs (Notes, Planner, Organizer, Journal, Reminders),
// note editors (the same Scratchbook as the laptop), settings, sync, reminders, sharing.
"use strict";

// ── small helpers (also used by the shared scratch.js) ────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function toast(msg, ms = 2200) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms); }
const touched = JSON.parse(Android.getPref("touched") || "{}");
const touch = p => { touched[p] = Date.now(); Android.setPref("touched", JSON.stringify(touched)); };

// The shared editor (scratch.js) talks to "the backend" through api(); on the phone
// that backend is local: rendering with temml, citations via the native fetch, images in storage.
async function api(method, path, body, raw) {
  if (method === "POST" && path === "render") {
    return { html: body.items.map(it => it.kind === "math" ? (it.text.trim() ? Render.math(it.text, true) : "")
      : it.kind === "code" ? Render.code(it.text, it.lang) : it.kind === "md" ? Render.md(it.text) : Render.inline(it.text)) };
  }
  if (method === "GET" && path.startsWith("cite?url=")) return Render.cite(decodeURIComponent(path.slice(9)));
  if (method === "POST" && path === "upload") {
    const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(raw.data); });
    const ext = (raw.name.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const stem = raw.name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "image";
    const rel = `assets/${stem}-${Math.random().toString(16).slice(2, 8)}.${ext}`;
    Store.writeB64("notes/" + rel, b64);
    return { path: rel };
  }
  throw new Error("not available on the phone: " + path);
}
const fileUrlCache = new Map();
window.keepFileUrl = rel => {
  if (fileUrlCache.has(rel)) return fileUrlCache.get(rel);
  const b64 = Store.readB64("notes/" + rel); const ext = rel.split(".").pop().toLowerCase();
  const url = b64 ? `data:image/${ext === "jpg" ? "jpeg" : ext === "svg" ? "svg+xml" : ext};base64,${b64}` : "";
  fileUrlCache.set(rel, url); return url;
};

// ── theme ───────────────────────────────────────────────────────────────────
function applyTheme() {
  const t = Android.getPref("theme") || "dark";
  document.documentElement.dataset.theme = t;
  $("#menu-theme-ic").textContent = t === "light" ? "dark_mode" : "light_mode";
  $("#menu-theme-t").textContent = t === "light" ? "Dark theme" : "Light theme";
}

// ── navigation: tabs + a stack of sub pages (back button) ───────────────────
const App = {
  tab: "notes", stack: [],
  go(tab) {
    this.leaveEditor(); this.stack = []; this.tab = tab; document.body.classList.remove("sub");
    $$("#navbar button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
    Tabs[tab].render();
  },
  push(title, render) {
    this.leaveEditor(); this.stack.push({ title, render });
    document.body.classList.add("sub"); this.show();
  },
  show() {
    const top = this.stack[this.stack.length - 1];
    $("#top-title").textContent = top.title; $("#screen").scrollTop = 0; top.render($("#screen"));
  },
  back() {
    if ($("#dialog-bg").classList.contains("open")) { $("#dialog-bg").classList.remove("open"); return true; }
    if ($("#chars").classList.contains("open")) { $("#chars").classList.remove("open"); return true; }
    if (document.body.classList.contains("menu-open")) { closeMenu(); return true; }
    if (!this.stack.length) return false;
    this.leaveEditor(); this.stack.pop();
    if (this.stack.length) this.show(); else this.go(this.tab);
    return true;
  },
  editorFlush: null,
  leaveEditor() { if (this.editorFlush) { this.editorFlush(); this.editorFlush = null; } document.body.classList.remove("editing-keep"); },
};
window.goBack = () => App.back();
function setTitle(t) { $("#top-title").textContent = t; }
function screen(html) { $("#screen").innerHTML = html; return $("#screen"); }

// ── dialogs ─────────────────────────────────────────────────────────────────
function dialog(html, ok, okLabel = "OK") {
  const bg = $("#dialog-bg"); $("#dialog-body").innerHTML = html; $("#dialog-ok").textContent = okLabel; bg.classList.add("open");
  $("#dialog-ok").onclick = async () => { try { if (await ok()) bg.classList.remove("open"); } catch (e) { toast(e.message); } };
  $("#dialog-cancel").onclick = () => bg.classList.remove("open");
  setTimeout(() => $("#dialog-body input, #dialog-body textarea")?.focus(), 80);
}
const confirmBox = (msg, label = "Delete") => new Promise(res => {
  dialog(`<h3>${esc(msg)}</h3>`, () => { res(true); return true; }, label);
  $("#dialog-cancel").onclick = () => { $("#dialog-bg").classList.remove("open"); res(false); };
});

// ═════════════════════════════════════════════════════════════════════════════
// Notes
// ═════════════════════════════════════════════════════════════════════════════
const NOTE_EXT = /^notes\/([^/]+)\.(keep|md|txt|tex|pdf)$/;
const ICON = { keep: "auto_stories", md: "markdown", txt: "notes", tex: "functions", pdf: "picture_as_pdf" };
function noteTitle(path, ext) {
  if (ext === "pdf") return path.replace(/^notes\//, "").replace(/\.pdf$/, "").replace(/-/g, " ");
  const t = Store.read(path) || "";
  if (ext === "keep") { try { return JSON.parse(t).title || "Untitled"; } catch { return "Untitled"; } }
  const m = ext === "md" ? t.match(/^#\s+(.+)$/m) : ext === "tex" ? t.match(/\\title\{([^}]*)\}/) : null;
  return (m ? m[1] : t.split("\n").find(l => l.trim()) || path.split("/").pop()).trim().slice(0, 80);
}
function allNotes() {
  return Store.list("notes/").map(p => { const m = p.match(NOTE_EXT); return m && { path: p, id: m[1], ext: m[2], title: noteTitle(p, m[2]) }; })
    .filter(Boolean).sort((a, b) => (touched[b.path] || 0) - (touched[a.path] || 0) || a.title.localeCompare(b.title));
}
function slug(title, ext) {
  let s = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "note", base = s, n = 2;
  const taken = new Set(Store.list("notes/"));
  while ([...taken].some(p => p.startsWith(`notes/${s}.`))) s = `${base}-${n++}`;
  return `notes/${s}.${ext}`;
}

const Tabs = {};
Tabs.notes = {
  q: "",
  render() {
    setTitle("Notes"); document.body.classList.remove("nofab");
    const notes = allNotes().filter(n => !this.q || n.title.toLowerCase().includes(this.q));
    const s = screen(`<div class="search"><span class="ms">search</span><input id="nq" placeholder="Search notes" value="${esc(this.q)}"></div>
      <div class="list">${notes.map(n => `<div class="item" data-p="${esc(n.path)}"><div class="lead"><span class="ms">${ICON[n.ext]}</span></div>
        <div class="grow"><div class="t">${esc(n.title)}</div><div class="s">${n.ext === "keep" ? "scratchbook" : n.ext}</div></div></div>`).join("")
        || `<div class="empty-state"><span class="ms">auto_stories</span>No notes yet. Tap the pen to start a scratchbook page, or sync with your laptop in Settings.</div>`}</div>`);
    $("#nq").oninput = e => { this.q = e.target.value.toLowerCase(); const pos = e.target.selectionStart; this.render(); const i = $("#nq"); i.focus(); i.setSelectionRange(pos, pos); };
    $$(".item", s).forEach(it => {
      it.onclick = () => openNote(it.dataset.p);
      let timer; it.ontouchstart = () => timer = setTimeout(async () => {
        if (await confirmBox(`Delete "${it.querySelector(".t").textContent}"?`)) { Store.remove(it.dataset.p); this.render(); toast("Deleted (synced on next sync)"); }
      }, 650);
      it.ontouchend = it.ontouchmove = () => clearTimeout(timer);
    });
  },
  fab() {
    dialog(`<h3>New note</h3><div class="seg" id="ntype"><button class="on" data-t="keep">Scratchbook</button><button data-t="md">Markdown</button><button data-t="txt">Text</button></div>
      <input class="field" id="ntitle" placeholder="Title">`, () => {
      const type = $("#ntype .on").dataset.t, title = $("#ntitle").value.trim() || "Untitled";
      const p = slug(title, type);
      Store.write(p, type === "keep" ? JSON.stringify({ title, blocks: [{ type: "text", md: "" }] }) : type === "md" ? `# ${title}\n\n` : `${title}\n\n`);
      touch(p); openNote(p); return true;
    }, "Create");
    $$("#ntype button").forEach(b => b.onclick = () => $$("#ntype button").forEach(x => x.classList.toggle("on", x === b)));
  },
};

function openNote(path) {
  const ext = path.split(".").pop();
  App.push(noteTitle(path, ext), el => {
    if (ext === "keep") {
      document.body.classList.add("editing-keep");
      el.innerHTML = `<div id="sb"></div>`;
      let data; try { data = JSON.parse(Store.read(path) || "{}"); } catch { data = { title: "", blocks: [] }; }
      const save = () => { Store.write(path, Scratch.serialize()); touch(path); setTitle(Scratch.title()); };
      const later = debounce(save, 700);
      Scratch.mount($("#sb"), data, later);
      App.editorFlush = save;
      return;
    }
    if (ext === "pdf") { el.innerHTML = `<div class="empty-state"><span class="ms">picture_as_pdf</span>PDF notes open on the laptop (gaussian_keep → Notes).</div>`; return; }
    let mode = "edit";
    const draw = () => {
      const text = Store.read(path) || "";
      el.innerHTML = `<div class="seg"><button data-m="edit" class="${mode === "edit" ? "on" : ""}">Edit</button><button data-m="view" class="${mode === "view" ? "on" : ""}">${ext === "tex" ? "Source info" : "Preview"}</button></div>
        <div class="note-page">${mode === "edit" ? `<textarea class="raw-editor" spellcheck="false">${esc(text)}</textarea>`
          : ext === "md" ? `<div class="typeset">${Render.md(text)}</div>` : ext === "tex" ? `<p class="help">LaTeX documents are compiled on the laptop (gaussian_keep → Ctrl+Enter). Edit the source here; it syncs.</p>`
          : `<div class="plaintext">${esc(text)}</div>`}</div>`;
      $$(".seg button", el).forEach(b => b.onclick = () => { App.editorFlush?.(); mode = b.dataset.m; draw(); });
      const t = $("textarea", el);
      if (t) {
        const save = () => { Store.write(path, t.value); touch(path); };
        t.oninput = debounce(save, 700); App.editorFlush = save;
        t.style.height = Math.max(innerHeight * 0.6, t.scrollHeight) + "px";
      }
    };
    draw();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Planner
// ═════════════════════════════════════════════════════════════════════════════
Tabs.planner = {
  date: today(),
  render() {
    document.body.classList.add("nofab");
    const d = new Date(this.date + "T00:00"), p = `planner/${this.date}.json`;
    const data = Store.json(p, { focus: "", tasks: [], blocks: [], notes: "" });
    const save = () => { Store.writeJSON(p, data); };
    setTitle(this.date === today() ? "Today" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }));
    const start = new Date(d); start.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const week = Array.from({ length: 7 }, (_, i) => { const x = new Date(start); x.setDate(start.getDate() + i); return x; });
    data.tasks.sort((a, b) => (a.done - b.done) || (a.time || "99").localeCompare(b.time || "99"));
    const s = screen(`<div class="week"><button data-step="-7"><span class="ms">chevron_left</span></button>${week.map(x => `<button data-d="${isoDate(x)}" class="${isoDate(x) === this.date ? "on" : ""} ${isoDate(x) === today() ? "today" : ""}">
        ${x.toLocaleDateString(undefined, { weekday: "narrow" })}<span class="d">${x.getDate()}</span></button>`).join("")}<button data-step="7"><span class="ms">chevron_right</span></button></div>
      <div class="card"><h3>Focus of the day</h3><input class="focus-input" id="pf" value="${esc(data.focus)}" placeholder="One thing that matters today…"></div>
      <div class="card"><h3>Tasks</h3><div id="pt">${data.tasks.map((t, i) => `<div class="task ${t.done ? "done" : ""}" data-i="${i}">
          <input type="checkbox" ${t.done ? "checked" : ""}><input class="time" value="${esc(t.time || "")}" placeholder="—:—"><input class="txt" value="${esc(t.text)}">
          <button class="icon-btn x">close</button></div>`).join("") || `<div class="help">Nothing planned yet.</div>`}</div>
        <div class="row-input"><input class="field" id="pa" placeholder="Add a task (14:30 call lab)"><button class="btn tonal" id="pab">Add</button></div></div>
      <div class="card"><h3>Notes</h3><textarea class="field" id="pn" rows="5">${esc(data.notes)}</textarea></div>
      <details class="card"><summary style="color:var(--md-primary);font-weight:500">Time blocks</summary>${Array.from({ length: 18 }, (_, k) => k + 6).map(h =>
        `<div class="block"><span class="h">${pad(h)}:00</span><input data-h="${h}" value="${esc((data.blocks.find(b => b.h === h) || {}).text || "")}" placeholder=" "></div>`).join("")}</details>`);
    $$(".week button", s).forEach(b => b.onclick = () => {
      if (b.dataset.step) { const x = new Date(d); x.setDate(d.getDate() + +b.dataset.step); this.date = isoDate(x); } else this.date = b.dataset.d;
      this.render();
    });
    $("#pf").oninput = e => { data.focus = e.target.value; save(); };
    $("#pn").oninput = debounce(e => { data.notes = e.target.value; save(); }, 400);
    const add = () => { const v = $("#pa").value.trim(); if (!v) return; const m = v.match(/^(\d{1,2}[:.]\d{2})\s+(.*)$/);
      data.tasks.push({ text: m ? m[2] : v, time: m ? m[1].replace(".", ":").padStart(5, "0") : "", done: false }); save(); this.render(); };
    $("#pab").onclick = add; $("#pa").onkeydown = e => { if (e.key === "Enter") add(); };
    $$("#pt .task", s).forEach(row => {
      const t = data.tasks[+row.dataset.i];
      row.querySelector("[type=checkbox]").onchange = e => { t.done = e.target.checked; save(); this.render(); };
      row.querySelector(".time").oninput = e => { t.time = e.target.value; save(); };
      row.querySelector(".txt").oninput = e => { t.text = e.target.value; save(); };
      row.querySelector(".x").onclick = () => { data.tasks.splice(+row.dataset.i, 1); save(); this.render(); };
    });
    $$(".block input", s).forEach(inp => inp.oninput = debounce(() => {
      const h = +inp.dataset.h, b = data.blocks.find(x => x.h === h);
      if (inp.value.trim()) { if (b) b.text = inp.value; else data.blocks.push({ h, text: inp.value }); } else if (b) data.blocks.splice(data.blocks.indexOf(b), 1);
      save();
    }, 400));
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Organizer (Keep cards)
// ═════════════════════════════════════════════════════════════════════════════
const COLORS = { "": "var(--md-surface-high)", blue: "#6aa5ff", amber: "#f2c66d", red: "#ff8f87", green: "#8fd6a6", violet: "#c5a3ff" };
Tabs.organizer = {
  render() {
    setTitle("Organizer"); document.body.classList.remove("nofab");
    const data = Store.json("organizer.json", { cards: [] });
    const save = debounce(() => Store.writeJSON("organizer.json", data), 400);
    const cards = data.cards.slice().sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
    const s = screen(cards.length ? `<div class="board">${cards.map(c => `<div class="kcard" data-id="${esc(c.id)}" data-color="${esc(c.color || "")}">
        <button class="icon-btn pin ${c.pinned ? "on" : ""}" data-act="pin">${c.pinned ? "keep" : "keep_off"}</button>
        <input class="ttl" value="${esc(c.title)}" placeholder="Title" data-f="title">
        ${c.items ? c.items.map((it, i) => `<div class="item-row item ${it.done ? "done" : ""}" style="padding:2px 0"><input type="checkbox" data-i="${i}" ${it.done ? "checked" : ""}>
          <input type="text" value="${esc(it.text)}" data-i="${i}" style="flex:1;border:0;background:transparent;outline:none;color:var(--text)"></div>`).join("") +
          `<div class="item" style="padding:2px 0"><span class="muted">＋</span><input type="text" data-new="1" placeholder="List item" style="flex:1;border:0;background:transparent;outline:none;color:var(--text)"></div>`
          : `<textarea data-f="text" rows="${Math.min(10, (c.text || "").split("\n").length + 1)}" placeholder="Note">${esc(c.text || "")}</textarea>`}
        <div class="actions">${Object.keys(COLORS).map(k => `<button class="dot" data-act="color" data-color="${k}" style="background:${COLORS[k]}"></button>`).join("")}
          <span class="grow"></span><button class="icon-btn" data-act="delete">delete</button></div></div>`).join("")}</div>`
      : `<div class="empty-state"><span class="ms">dashboard</span>Quick notes and checklists. Tap the pen to add one.</div>`);
    const card = el => data.cards.find(c => c.id === el.closest(".kcard").dataset.id);
    s.oninput = e => { const c = card(e.target); if (!c) return; c.updated = Date.now() / 1000;
      if (e.target.dataset.f) c[e.target.dataset.f] = e.target.value; else if (e.target.type === "text" && e.target.dataset.i !== undefined) c.items[+e.target.dataset.i].text = e.target.value; save(); };
    s.onkeydown = e => { if (e.key === "Enter" && e.target.dataset.new && e.target.value.trim()) { const c = card(e.target); c.items.push({ text: e.target.value.trim(), done: false });
      Store.writeJSON("organizer.json", data); this.render(); $(`.kcard[data-id="${c.id}"] input[data-new]`)?.focus(); } };
    s.onchange = e => { if (e.target.type !== "checkbox") return; const c = card(e.target); c.items[+e.target.dataset.i].done = e.target.checked; Store.writeJSON("organizer.json", data); this.render(); };
    s.onclick = async e => { const act = e.target.dataset.act; if (!act) return; const c = card(e.target);
      if (act === "pin") c.pinned = !c.pinned;
      if (act === "color") c.color = e.target.dataset.color;
      if (act === "delete") { if (!(await confirmBox("Delete this card?"))) return; data.cards = data.cards.filter(x => x !== c); }
      Store.writeJSON("organizer.json", data); this.render(); };
  },
  fab() {
    dialog(`<h3>New card</h3><div class="seg" id="ctype"><button class="on" data-t="note">Note</button><button data-t="list">Checklist</button></div><input class="field" id="ctitle" placeholder="Title">`, () => {
      const data = Store.json("organizer.json", { cards: [] });
      data.cards.push({ id: Math.random().toString(36).slice(2, 10), title: $("#ctitle").value.trim(), text: "", color: "", pinned: false,
        items: $("#ctype .on").dataset.t === "list" ? [] : undefined, updated: Date.now() / 1000 });
      Store.writeJSON("organizer.json", data); this.render(); return true;
    }, "Add");
    $$("#ctype button").forEach(b => b.onclick = () => $$("#ctype button").forEach(x => x.classList.toggle("on", x === b)));
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Journal
// ═════════════════════════════════════════════════════════════════════════════
Tabs.journal = {
  render() {
    setTitle("Journal"); document.body.classList.add("nofab");
    const days = [...new Set([today(), ...Store.list("journal/").map(p => p.match(/^journal\/(\d{4}-\d{2}-\d{2})\.md$/)?.[1]).filter(Boolean)])].sort().reverse();
    const s = screen(`<div class="list">${days.map(d => { const t = Store.read(`journal/${d}.md`) || "";
      return `<div class="item" data-d="${d}"><div class="lead"><span class="ms">${t ? "edit_note" : "add"}</span></div><div class="grow">
        <div class="t">${new Date(d + "T00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</div>
        <div class="s">${esc(t.replace(/[#*$`>-]/g, "").trim().slice(0, 70)) || "new entry"}</div></div></div>`; }).join("")}</div>`);
    $$(".item", s).forEach(it => it.onclick = () => openJournal(it.dataset.d));
  },
};
function openJournal(d) {
  const p = `journal/${d}.md`;
  App.push(new Date(d + "T00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), el => {
    let mode = (Store.read(p) || "").trim() ? "view" : "edit";
    const draw = () => {
      const text = Store.read(p) || "";
      el.innerHTML = `<div class="seg"><button data-m="edit" class="${mode === "edit" ? "on" : ""}">Write</button><button data-m="view" class="${mode === "view" ? "on" : ""}">Read</button></div>
        <div class="note-page">${mode === "edit" ? `<button class="btn ghost" id="jt">＋ research template</button><textarea class="raw-editor" spellcheck="false" placeholder="What did you try today? What did you learn?">${esc(text)}</textarea>`
          : `<div class="typeset">${Render.md(text) || "<p class='help'>Nothing written yet.</p>"}</div>`}</div>`;
      $$(".seg button", el).forEach(b => b.onclick = () => { App.editorFlush?.(); mode = b.dataset.m; draw(); });
      const t = $("textarea", el);
      if (t) {
        const save = () => { if (t.value.trim()) Store.write(p, t.value); else if (Store.read(p) != null) Store.remove(p); };
        t.oninput = debounce(save, 700); App.editorFlush = save; t.style.height = innerHeight * 0.6 + "px";
        $("#jt").onclick = () => { t.value = (t.value.trim() ? t.value.trimEnd() + "\n\n" : "") + "## Goal\n\n\n## What I did\n- \n\n## Results\n\n\n## Problems / questions\n- \n\n## Next steps\n- [ ] \n"; save(); t.focus(); };
      }
    };
    draw();
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Reminders (same file as the laptop's calendar; notifications on the phone too)
// ═════════════════════════════════════════════════════════════════════════════
const Reminders = {
  load: () => Store.json("reminders.json", []),
  save(items) { Store.writeJSON("reminders.json", items); this.schedule(items); },
  schedule(items = this.load()) {
    const before = JSON.parse(Android.getPref("scheduled") || "[]"), now = Date.now(), keep = [];
    items.forEach(r => { const t = new Date(`${r.date}T${r.time}`).getTime(); if (!r.fired && t > now) { Android.scheduleReminder(r.id, t, r.text); keep.push(r.id); } });
    before.filter(id => !keep.includes(id)).forEach(id => Android.cancelReminder(id));
    Android.setPref("scheduled", JSON.stringify(keep));
  },
};
Tabs.reminders = {
  render() {
    setTitle("Reminders"); document.body.classList.add("nofab");
    const items = Reminders.load().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)); const now = new Date();
    const past = r => r.fired || new Date(`${r.date}T${r.time}`) < now;
    const row = r => `<div class="rem ${past(r) ? "past" : ""}" data-id="${esc(r.id)}"><span class="when">${new Date(r.date + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${esc(r.time)}</span>
      <span class="txt">${esc(r.text)}</span><button class="icon-btn" data-act="edit">edit</button><button class="icon-btn" data-act="delete">delete</button></div>`;
    const s = screen(`<div class="card"><h3>New reminder</h3><div class="form-grid"><input class="field" type="date" id="rd" value="${today()}"><input class="field" type="time" id="rt" value="09:00">
        <input class="field full" id="rx" placeholder="Remind me to…"><button class="btn primary full" id="ra">Add</button></div>
        <p class="help" style="margin:10px 0 0">Shared with the laptop's calendar. This phone notifies you on time too.</p></div>
      ${items.filter(r => !past(r)).length ? `<div class="section-title">Upcoming</div>${items.filter(r => !past(r)).map(row).join("")}` : ""}
      ${items.filter(past).length ? `<div class="section-title">Done / past</div>${items.filter(past).reverse().map(row).join("")}` : ""}`);
    $("#ra").onclick = () => { const text = $("#rx").value.trim(); if (!text) return $("#rx").focus();
      const all = Reminders.load(); all.push({ id: Math.random().toString(16).slice(2, 10), date: $("#rd").value, time: $("#rt").value, text, fired: false });
      Reminders.save(all); toast("Reminder set"); this.render(); };
    s.onclick = async e => { const act = e.target.dataset.act; if (!act) return; const id = e.target.closest(".rem").dataset.id; const all = Reminders.load(); const r = all.find(x => x.id === id);
      if (act === "delete") { if (await confirmBox("Delete this reminder?")) { Reminders.save(all.filter(x => x !== r)); this.render(); } }
      if (act === "edit") dialog(`<h3>Edit reminder</h3><div class="form-grid"><input class="field" type="date" id="ed" value="${r.date}"><input class="field" type="time" id="et" value="${r.time}">
          <input class="field full" id="ex" value="${esc(r.text)}"></div>`, () => {
        Object.assign(r, { date: $("#ed").value, time: $("#et").value, text: $("#ex").value.trim() || r.text });
        r.fired = new Date(`${r.date}T${r.time}`) < new Date(); Reminders.save(all); this.render(); return true; }, "Save");
    };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// Settings
// ═════════════════════════════════════════════════════════════════════════════
function openSettings() {
  App.push("Settings", el => {
    const c = Store.cfg(), last = +Android.getPref("lastSync") || 0;
    el.innerHTML = `<div class="settings-page">
      <div class="card" style="margin:0"><h3>Sync with your laptop (GitHub)</h3>
        <label>Repository (owner/name)</label><input class="field" id="sr" value="${esc(c.repo)}" placeholder="your-username/your-notes-repo">
        <label style="margin-top:12px">Access token</label><input class="field" id="st" type="password" placeholder="${c.token ? "saved: paste a new one to replace it" : "github_pat_…"}">
        <div class="row-input"><button class="btn primary" id="ss">Save & sync now</button><span class="help">${last ? "last sync " + new Date(last).toLocaleString() : "never synced"} · ${Store.dirtyCount()} local change(s)</span></div>
        <p class="help">1. On github.com create a <b>private</b> repository for your notes and tick <b>Add a README</b>.<br>
          2. Settings → Developer settings → Fine-grained tokens: give it access to <b>only that repository</b>, permission <b>Contents: Read and write</b>.<br>
          The token is stored only in this app's private storage. Never share it.</p></div>
      <div class="card" style="margin:0"><h3>Appearance</h3><div class="seg" id="sth" style="margin:0">
        <button data-t="dark">Dark</button><button data-t="light">Light</button></div></div>
      <div class="brand"><img src="icon.png" alt=""><div><b>gaussian_keep</b><div class="help">version ${esc(Android.version())} · notes, planner, organizer, journal, reminders</div></div></div>
    </div>`;
    const th = Android.getPref("theme") || "dark";
    $$("#sth button", el).forEach(b => { b.classList.toggle("on", b.dataset.t === th); b.onclick = () => { Android.setPref("theme", b.dataset.t); applyTheme(); App.show(); }; });
    $("#ss").onclick = async () => {
      Android.setPref("repo", $("#sr").value.trim()); if ($("#st").value.trim()) Android.setPref("token", $("#st").value.trim());
      try { const r = await Store.sync(); toast(`Synced: ${r.downloaded} in, ${r.uploaded} out${r.conflicts ? `, ${r.conflicts} conflict copies` : ""}`); App.show(); }
      catch (e) { toast(e.message, 5000); }
    };
  });
}

// ── sync now (top-bar cloud icon and ⋮ menu) ────────────────────────────────
async function syncNow() {
  if (!Store.cfg().token) { toast("Add your GitHub token first"); return openSettings(); }
  try {
    App.editorFlush?.(); const r = await Store.sync();
    toast(r.downloaded || r.uploaded || r.conflicts ? `Synced: ${r.downloaded} in, ${r.uploaded} out${r.conflicts ? `, ${r.conflicts} conflict copies` : ""}` : "Already in sync");
  } catch (e) { toast(e.message, 5000); }
}
function updateMenu() {
  const last = +Android.getPref("lastSync") || 0, n = Store.dirtyCount();
  $("#menu-sync-sub").textContent = !Store.cfg().token ? "set up in Settings first"
    : (last ? "last " + new Date(last).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "never synced") + (n ? ` · ${n} to upload` : " · up to date");
}
function closeMenu() { document.body.classList.remove("menu-open"); }

// ── sync status + triggers ──────────────────────────────────────────────────
Store.on((state, detail) => {
  const b = $("#sync-btn");
  b.classList.toggle("spin", state === "syncing");
  b.textContent = state === "syncing" ? "sync" : state === "error" ? "cloud_off" : Store.dirtyCount() ? "cloud_upload" : "cloud_done";
  b.title = state === "error" ? "Sync failed: " + detail : "Sync with GitHub";
  if (state === "done") {
    Reminders.schedule(); fileUrlCache.clear();
    if (detail?.downloaded && !App.stack.length) Tabs[App.tab].render();
  }
});
async function quietSync() { if (!Store.cfg().token) return; try { App.editorFlush?.(); await Store.sync(); } catch (e) { /* icon shows it */ } }
window.onAppPause = () => { App.editorFlush?.(); quietSync(); };
setInterval(quietSync, 3 * 60 * 1000);

// ── "Share → gaussian_keep": a link becomes a citation in the Reading list ──
window.onShared = async text => {
  const url = (text.match(/https?:\/\/\S+/) || [text.trim()])[0];
  toast("Reading the link…");
  try {
    const r = Render.cite(url);
    const p = "notes/reading-list.keep";
    const doc = Store.json(p, { title: "Reading list", blocks: [] });
    doc.blocks.push({ type: "quote", text: "", ref: { title: r.title, authors: r.authors, year: r.year, venue: r.venue, doi: r.doi, url: r.url, accessed: r.accessed } });
    Store.write(p, JSON.stringify(doc, null, 1)); touch(p);
    App.go("notes"); openNote(p); toast("Added to Reading list");
  } catch (e) { toast("Could not read that link: " + e.message, 4000); }
};

// ── characters sheet ────────────────────────────────────────────────────────
const CHARS = {
  greek: "α β γ δ ε ϵ ζ η θ ϑ ι κ λ μ ν ξ π ρ σ ς τ υ φ ϕ χ ψ ω", GREEK: "Α Β Γ Δ Ε Ζ Η Θ Λ Ξ Π Σ Υ Φ Ψ Ω",
  math: "± ∓ × ÷ · ∘ √ ∞ ∝ ∑ ∏ ∫ ∮ ∂ ∇ ≈ ≃ ≡ ≠ ≤ ≥ ≪ ≫ ∼ ′ ° ∠ ⊥ ∥", physics: "ℏ ħ ⟨ ⟩ | † ⊗ ⊕ ℒ ℋ ℓ Å µ Ω ε₀ μ₀ □",
  sets: "∈ ∉ ⊂ ⊃ ⊆ ⊇ ∪ ∩ ∅ ℕ ℤ ℚ ℝ ℂ ∀ ∃ ¬ ∧ ∨ ∴ ∵", arrows: "→ ← ↔ ⇒ ⇐ ⇔ ↦ ↑ ↓ ⇌ ⟶ ⟹",
  "sup/sub": "⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ⁺ ⁻ ⁿ ₀ ₁ ₂ ₃ ₄ ₅ ₆ ₇ ₈ ₉ ᵢ ⱼ",
};
let charTab = "greek";
function drawChars() {
  $("#chars-tabs").innerHTML = Object.keys(CHARS).map(k => `<button class="chip ${k === charTab ? "on" : ""}" data-t="${k}">${k}</button>`).join("");
  $("#chars-grid").innerHTML = CHARS[charTab].split(" ").map(c => `<button>${c}</button>`).join("");
}

// ── start ───────────────────────────────────────────────────────────────────
(function start() {
  applyTheme(); drawChars();
  $$("#navbar button").forEach(b => b.onclick = () => App.go(b.dataset.tab));
  $("#back").onclick = () => App.back();
  $("#sync-btn").onclick = syncNow;
  $("#menu-btn").onclick = () => { updateMenu(); document.body.classList.add("menu-open"); };
  $("#menu-scrim").onclick = closeMenu;
  $$("#menu button").forEach(b => b.onclick = () => {
    closeMenu();
    if (b.dataset.m === "sync") syncNow();
    if (b.dataset.m === "theme") { Android.setPref("theme", (Android.getPref("theme") || "dark") === "dark" ? "light" : "dark"); applyTheme(); }
    if (b.dataset.m === "settings") openSettings();
  });
  $("#fab").onclick = () => Tabs[App.tab].fab?.();
  $$("#insertbar [data-sb]").forEach(b => { b.onmousedown = e => e.preventDefault(); b.onclick = () => Scratch.add(b.dataset.sb); });
  $("#chars-btn").onmousedown = e => e.preventDefault();
  $("#chars-btn").onclick = () => $("#chars").classList.toggle("open");
  $("#chars-tabs").onclick = e => { if (e.target.dataset.t) { charTab = e.target.dataset.t; drawChars(); } };
  $("#chars-grid").onmousedown = e => e.preventDefault();
  $("#chars-grid").onclick = e => { if (e.target.tagName === "BUTTON" && !Scratch.insertChar(e.target.textContent)) toast("Tap into the text first"); };
  App.go("notes");
  Reminders.schedule();
  quietSync();
})();
