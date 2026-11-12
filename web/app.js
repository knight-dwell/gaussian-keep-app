// gaussian_keep front end (vanilla JS, no libraries).
"use strict";

const TOKEN = new URLSearchParams(location.search).get("token") || "";
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());

async function api(method, path, body, raw) {
  const opts = { method, headers: { "X-Keep-Token": TOKEN } };
  if (raw) { opts.body = raw.data; opts.headers["X-Filename"] = encodeURIComponent(raw.name); opts.headers["Content-Type"] = "application/octet-stream"; }
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  const r = await fetch("/api/" + path, opts);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function toast(msg, ms = 2200) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function ago(ts) {
  const s = (Date.now() / 1000) - ts;
  if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`; return new Date(ts * 1000).toLocaleDateString();
}

// ── settings + theme ─────────────────────────────────────────────────────────
let settings = {};
function applySettings() {
  document.documentElement.dataset.theme = settings.theme || "dark";
  const fontMap = { "Latin Modern Mono": "LM Mono Light" };
  const r = document.documentElement.style;
  r.setProperty("--editor-font", `"${fontMap[settings.editorFont] || settings.editorFont}"`);
  r.setProperty("--preview-font", `"${settings.previewFont || "LM Roman"}"`);
  r.setProperty("--editor-size", settings.fontSize + "px");
  r.setProperty("--editor-lh", settings.lineHeight);
  $("#theme-toggle .ms").textContent = settings.theme === "light" ? "light_mode" : "dark_mode";
}
async function saveSettings(patch) { settings = await api("PUT", "settings", patch); applySettings(); }

// ── navigation between sections ──────────────────────────────────────────────
const views = {};
function show(name) {
  $$(".view").forEach(v => v.classList.toggle("on", v.id === "view-" + name));
  $$("#rail button[data-view]").forEach(b => b.classList.toggle("on", b.dataset.view === name));
  location.hash = name;
  views[name]?.open?.();
}

// ═════════════════════════════════════════════════════════════════════════════
// Notes
// ═════════════════════════════════════════════════════════════════════════════
const Notes = {
  all: [], current: null, filter: "all", dirty: false, previewOn: true,

  async open() { await this.refresh(); if (!this.current && this.visible().length) this.load(this.visible()[0].id); },

  visible() {
    const q = $("#note-search").value.trim().toLowerCase();
    return this.all.filter(n => (this.filter === "all" || n.type === this.filter) && (!q || n.title.toLowerCase().includes(q)));
  },

  async refresh() { this.all = await api("GET", "notes"); this.renderList(); },

  renderList() {
    const list = this.visible();
    $("#notes").innerHTML = list.length ? list.map(n => `
      <div class="note-item ${this.current?.id === n.id ? "on" : ""}" data-id="${esc(n.id)}">
        <div class="t">${esc(n.title)}</div>
        <div class="m"><span class="tag ${n.type}">${n.type}</span>${ago(n.updated)}</div>
      </div>`).join("") : `<div class="empty">No notes here yet</div>`;
    this.updatePageNo();
  },

  async load(id, direction) {
    await this.save();
    const page = $("#page");
    const flip = direction && settings.pageFlip !== false;
    if (flip) { page.className = "out-" + direction; await new Promise(r => setTimeout(r, 260)); }
    const n = await api("GET", "notes/" + encodeURIComponent(id));
    this.current = n;
    $("#note-title").textContent = n.title;
    $("#note-type").textContent = n.type; $("#note-type").className = "tag " + n.type;
    const keep = n.type === "keep";
    document.body.classList.toggle("keep-note", keep);
    if (keep) {
      let data; try { data = JSON.parse(n.content || "{}"); } catch { data = { title: n.title, blocks: [] }; }
      Scratch.mount($("#sb"), data, () => { this.dirty = true; $("#save-state").textContent = "…"; this.autosave(); });
      $("#editor").value = "";
    } else $("#editor").value = n.content;
    page.className = n.type === "pdf" ? "is-pdf" : keep ? "is-keep" : "";
    if (flip) { void page.offsetWidth; page.classList.add("in-" + direction); }
    $("#save-state").textContent = "";
    $("#pdf-view").innerHTML = "";
    $("#preview").innerHTML = `<div class="empty">Ctrl+Enter compiles this note</div>`;
    $("#compile-log").classList.remove("show");
    this.renderList();
    if (n.type === "pdf") this.compile();
    else if (!keep) this.compile(true);   // quiet: show the preview right away (LaTeX takes ~1 s)
    if (keep) {
      $("#preview").innerHTML = `<div class="empty">The scratchbook is its own preview.<br>Ctrl+Enter (outside a block) typesets it as a PDF here.</div>`;
      if (!this.previewForced) { $("#preview-pane").classList.add("hidden"); $("#tb-preview").classList.remove("on"); }
    } else if (this.previewOn) { $("#preview-pane").classList.remove("hidden"); $("#tb-preview").classList.add("on"); }
    else if (n.type !== "pdf") $("#editor").focus();
  },

  async save() {
    if (!this.current || !this.dirty || this.current.type === "pdf") return;
    this.dirty = false;
    try {
      const content = this.current.type === "keep" ? Scratch.serialize() : $("#editor").value;
      const r = await api("PUT", "notes/" + encodeURIComponent(this.current.id), { content });
      $("#save-state").textContent = "saved";
      if (r.title !== this.current.title) { this.current.title = r.title; $("#note-title").textContent = r.title; }
      const item = this.all.find(n => n.id === this.current.id);
      if (item) { item.title = r.title; item.updated = r.updated; }
      this.renderList();
    } catch (e) { this.dirty = true; $("#save-state").textContent = "not saved!"; toast("Save failed: " + e.message); }
  },

  async compile(quiet) {
    if (!this.current) return;
    await this.save();
    const t = this.current.type;
    $("#compile-state").textContent = t === "tex" || t === "keep" ? "typesetting…" : "";
    try {
      const r = await api("POST", `notes/${encodeURIComponent(this.current.id)}/compile`);
      const log = $("#compile-log");
      log.textContent = r.log || ""; log.classList.toggle("show", !!(r.log && (!r.ok || t === "tex")));
      if (r.kind === "html") $("#preview").innerHTML = r.html || `<div class="empty">Nothing to show yet</div>`;
      else if (r.kind === "text") $("#preview").innerHTML = `<div class="plaintext">${esc(r.text)}</div>`;
      else if (r.kind === "pdf") {
        const imgs = r.pages.map(u => `<img class="pdf-page" src="${u}" loading="lazy">`).join("");
        if (t === "pdf") $("#pdf-view").innerHTML = imgs || `<div class="empty">Could not render this PDF</div>`;
        $("#preview").innerHTML = imgs || `<div class="empty">Compile failed: see the log below</div>`;
        this.lastPdf = r.pdf;
      }
      $("#compile-state").textContent = r.ok ? (t === "tex" || t === "keep" ? "compiled ✓" : "") : "errors";
      if (!quiet && !r.ok) toast("Compile failed: details under the preview");
    } catch (e) { $("#compile-state").textContent = "error"; toast(e.message); }
  },

  async create(type) {
    if (type === "pdf") return $("#file-pdf").click();
    const title = prompt({ keep: "Title of the scratchbook page:", md: "Title of the Markdown note:", tex: "Title of the LaTeX note:", txt: "Title of the text note:" }[type], "Untitled");
    if (title === null) return;
    const r = await api("POST", "notes", { type, title });
    $("#note-search").value = ""; this.filter = "all"; $$(".filters .chip").forEach(c => c.classList.toggle("on", c.dataset.filter === "all"));
    await this.refresh(); this.load(r.id, "next");
  },

  async remove() {
    if (!this.current || !confirm(`Move "${this.current.title}" to the trash (~/gaussian_keep/.trash)?`)) return;
    await api("DELETE", "notes/" + encodeURIComponent(this.current.id));
    this.current = null; this.dirty = false; await this.refresh();
    const v = this.visible(); if (v.length) this.load(v[0].id, "prev"); else { $("#editor").value = ""; $("#note-title").textContent = "—"; }
  },

  flip(step) {
    const v = this.visible(); if (!v.length) return;
    const i = Math.max(0, v.findIndex(n => n.id === this.current?.id));
    const j = i + step; if (j < 0 || j >= v.length) { toast(step > 0 ? "Last page" : "First page", 900); return; }
    this.load(v[j].id, step > 0 ? "next" : "prev");
  },

  updatePageNo() {
    const v = this.visible(); const i = v.findIndex(n => n.id === this.current?.id);
    $("#page-no").textContent = i >= 0 ? `${i + 1} / ${v.length}` : "";
  },

  // insert text at the cursor and keep the editor focused
  // insert text at the cursor; if it contains «placeholder», that part is
  // selected so typing replaces it
  insert(text) {
    const ed = $("#editor"); const s = ed.selectionStart;
    const m = text.match(/«([^»]*)»/); const clean = text.replace(/[«»]/g, "");
    ed.focus();
    // execCommand keeps it in the undo history (Ctrl+Z); setRangeText would not
    if (!document.execCommand("insertText", false, clean)) ed.setRangeText(clean, s, ed.selectionEnd, "end");
    if (m) { ed.selectionStart = s + m.index; ed.selectionEnd = s + m.index + m[1].length; }
    ed.focus(); this.dirty = true; this.autosave();
  },

  table(rows, cols) {
    const t = this.current?.type;
    if (t === "tex") {
      const head = Array.from({ length: cols }, (_, i) => `head ${i + 1}`).join(" & ");
      const row = Array.from({ length: cols }, () => "  ").join(" & ");
      this.insert(`\n\\begin{table}[h]\\centering\n\\begin{tabular}{${"l".repeat(cols)}}\\toprule\n${head} \\\\ \\midrule\n` +
        Array.from({ length: rows - 1 }, () => row + " \\\\").join("\n") + `\n\\bottomrule\n\\end{tabular}\n\\end{table}\n`);
    } else {
      const head = "| " + Array.from({ length: cols }, (_, i) => `head ${i + 1}`).join(" | ") + " |";
      const sep = "|" + "---|".repeat(cols);
      const row = "| " + Array.from({ length: cols }, () => "   ").join(" | ") + " |";
      this.insert(`\n${head}\n${sep}\n${Array.from({ length: rows - 1 }, () => row).join("\n")}\n`);
    }
  },

  async image(file) {
    const r = await api("POST", "upload", undefined, { name: file.name, data: file });
    if (this.current?.type === "tex")
      this.insert(`\n\\begin{figure}[h]\\centering\n  \\includegraphics[width=0.8\\linewidth]{${r.path}}\n  \\caption{}\n\\end{figure}\n`);
    else this.insert(`\n![caption](${r.path})\n`);
    toast("Image added");
  },

  math() {   // never leave a blank line inside: LaTeX/pandoc treat it as a paragraph break
    if (this.current?.type === "tex") this.insert("\n\\begin{equation}\n  «E = mc^2»\n\\end{equation}\n");
    else this.insert("\n$$\n«E = mc^2»\n$$\n");
  },

  async export() {
    if (!this.current) return;
    toast("Making the PDF…");
    const r = await api("POST", `notes/${encodeURIComponent(this.current.id)}/export`);
    if (r.ok && r.pdf) {   // the window opens it in your PDF viewer (the browser has no access token)
      toast("PDF ready: opening it"); window.webkit?.messageHandlers?.keep?.postMessage("open:" + r.pdf.replace(/^\/files\//, ""));
    }
    else { $("#compile-log").textContent = r.log; $("#compile-log").classList.add("show"); toast("Export failed"); }
  },

  focusMode(on) {
    document.body.classList.toggle("focus", on ?? !document.body.classList.contains("focus"));
    window.webkit?.messageHandlers?.keep?.postMessage(document.body.classList.contains("focus") ? "fullscreen" : "exit-fullscreen");
  },

  init() {
    const ed = $("#editor");
    this.autosave = debounce(() => this.save(), 700);
    ed.addEventListener("input", () => { this.dirty = true; $("#save-state").textContent = "…"; this.autosave(); });
    ed.addEventListener("keydown", e => {   // Tab inserts spaces, Enter keeps list/indent
      if (e.key === "Tab") { e.preventDefault(); this.insert("    "); }
      if (e.key === "Enter" && !e.ctrlKey && !e.altKey) {
        const before = ed.value.slice(0, ed.selectionStart); const line = before.slice(before.lastIndexOf("\n") + 1);
        const m = line.match(/^(\s*)([-*+] (\[[ x]\] )?|\d+\. )?/);
        if (m && m[0] && line.trim() !== m[0].trim()) {
          e.preventDefault();
          let bullet = m[2] || ""; const num = bullet.match(/^(\d+)\. $/); if (num) bullet = `${+num[1] + 1}. `;
          bullet = bullet.replace("[x]", "[ ]"); this.insert("\n" + m[1] + bullet);
        }
      }
    });
    $("#notes").addEventListener("click", e => { const it = e.target.closest(".note-item"); if (it) this.load(it.dataset.id); });
    $("#note-search").addEventListener("input", () => this.renderList());
    $$(".filters .chip").forEach(c => c.addEventListener("click", () => {
      this.filter = c.dataset.filter; $$(".filters .chip").forEach(x => x.classList.toggle("on", x === c)); this.renderList();
    }));
    $("#new-note-btn").addEventListener("click", e => { e.stopPropagation(); $("#new-menu").classList.toggle("open"); });
    $$("#new-menu button").forEach(b => b.addEventListener("click", () => { $("#new-menu").classList.remove("open"); this.create(b.dataset.new); }));
    document.addEventListener("click", () => { $("#new-menu").classList.remove("open"); $("#table-picker").classList.remove("open"); });
    $("#tb-compile").addEventListener("click", () => this.compile());
    $("#tb-preview").addEventListener("click", () => {
      const show = $("#preview-pane").classList.contains("hidden");
      if (this.current?.type === "keep") this.previewForced = show; else this.previewOn = show;
      $("#preview-pane").classList.toggle("hidden", !show); $("#tb-preview").classList.toggle("on", show);
    });
    $("#tb-export").addEventListener("click", () => this.export());
    $("#tb-focus").addEventListener("click", () => this.focusMode());
    $("#tb-delete").addEventListener("click", () => this.remove());
    $("#tb-math").addEventListener("click", () => this.math());
    $("#tb-image").addEventListener("click", () => $("#file-image").click());
    $("#file-image").addEventListener("change", e => { const f = e.target.files[0]; if (f) this.image(f); e.target.value = ""; });
    $("#file-pdf").addEventListener("change", async e => {
      const f = e.target.files[0]; e.target.value = ""; if (!f) return;
      const r = await api("POST", "upload", undefined, { name: f.name, data: f }); await this.refresh(); this.load(r.id, "next");
    });
    $("#prev-page").addEventListener("click", () => this.flip(-1));
    $("#next-page").addEventListener("click", () => this.flip(1));
    // table size picker: hover to choose rows × columns, click to insert
    const grid = $("#table-grid");
    for (let r = 1; r <= 6; r++) for (let c = 1; c <= 8; c++) {
      const d = document.createElement("div"); d.dataset.r = r; d.dataset.c = c; grid.appendChild(d);
    }
    grid.addEventListener("mouseover", e => {
      const { r, c } = e.target.dataset; if (!r) return;
      $$("#table-grid div").forEach(d => d.classList.toggle("hl", +d.dataset.r <= +r && +d.dataset.c <= +c));
      $("#table-size").textContent = `${r} × ${c}`;
    });
    grid.addEventListener("click", e => { const { r, c } = e.target.dataset; if (r) { this.table(+r, +c); $("#table-picker").classList.remove("open"); } });
    $("#tb-table").addEventListener("click", e => {
      e.stopPropagation(); const p = $("#table-picker"); p.classList.toggle("open");
      p.style.left = (e.target.getBoundingClientRect().left - p.parentElement.getBoundingClientRect().left - 120) + "px";
    });
    $("#table-picker").addEventListener("click", e => e.stopPropagation());
  },
};
views.notes = Notes;

// ═════════════════════════════════════════════════════════════════════════════
// Planner
// ═════════════════════════════════════════════════════════════════════════════
const Planner = {
  date: today(), data: null,
  async open() { await this.load(this.date); },
  async load(d) {
    this.date = d; this.data = await api("GET", "planner/" + d);
    const dt = new Date(d + "T00:00");
    $("#plan-title").textContent = d === today() ? "Today · " + dt.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })
      : dt.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    $("#plan-focus").value = this.data.focus || "";
    $("#plan-notes").value = this.data.notes || "";
    this.renderWeek(dt); this.renderTasks(); this.renderBlocks();
  },
  save: debounce(function () { api("PUT", "planner/" + Planner.date, Planner.data); }, 500),
  renderWeek(dt) {
    const start = new Date(dt); start.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
    $("#plan-week").innerHTML = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i); const iso = isoDate(d);
      return `<button data-d="${iso}" class="${iso === this.date ? "on" : ""} ${iso === today() ? "today" : ""}">
        ${d.toLocaleDateString(undefined, { weekday: "short" })}<span class="d">${d.getDate()}</span></button>`;
    }).join("");
  },
  renderTasks() {
    const tasks = this.data.tasks;
    tasks.sort((a, b) => (a.done - b.done) || (a.time || "99").localeCompare(b.time || "99"));
    $("#plan-tasks").innerHTML = tasks.length ? tasks.map((t, i) => `
      <div class="task ${t.done ? "done" : ""}" data-i="${i}">
        <input type="checkbox" ${t.done ? "checked" : ""}>
        <input class="time" value="${esc(t.time || "")}" placeholder="—:—">
        <input class="txt" value="${esc(t.text)}">
        <button class="icon-btn x" title="Remove">close</button>
      </div>`).join("") : `<div class="empty" style="padding:10px">Nothing planned. Add a task below.</div>`;
  },
  renderBlocks() {
    const blocks = this.data.blocks || (this.data.blocks = []);
    const now = new Date(); const isToday = this.date === today();
    let html = "";
    for (let h = 6; h <= 23; h++) {
      const b = blocks.find(x => x.h === h);
      html += `<div class="block ${isToday && now.getHours() === h ? "now" : ""}"><span class="h">${pad(h)}:00</span>
        <input data-h="${h}" value="${esc(b ? b.text : "")}" placeholder=" "></div>`;
    }
    $("#plan-blocks").innerHTML = html;
  },
  init() {
    $("#plan-prev").onclick = () => { const d = new Date(this.date + "T00:00"); d.setDate(d.getDate() - 1); this.load(isoDate(d)); };
    $("#plan-next").onclick = () => { const d = new Date(this.date + "T00:00"); d.setDate(d.getDate() + 1); this.load(isoDate(d)); };
    $("#plan-today").onclick = () => this.load(today());
    $("#plan-week").addEventListener("click", e => { const b = e.target.closest("button"); if (b) this.load(b.dataset.d); });
    $("#plan-focus").addEventListener("input", e => { this.data.focus = e.target.value; this.save(); });
    $("#plan-notes").addEventListener("input", e => { this.data.notes = e.target.value; this.save(); });
    $("#plan-add").addEventListener("keydown", e => {
      if (e.key !== "Enter" || !e.target.value.trim()) return;
      const m = e.target.value.trim().match(/^(\d{1,2}[:.]\d{2})\s+(.*)$/);
      this.data.tasks.push({ text: m ? m[2] : e.target.value.trim(), time: m ? m[1].replace(".", ":").padStart(5, "0") : "", done: false });
      e.target.value = ""; this.renderTasks(); this.save();
    });
    $("#plan-tasks").addEventListener("input", e => {
      const row = e.target.closest(".task"); if (!row) return; const t = this.data.tasks[+row.dataset.i];
      if (e.target.classList.contains("txt")) t.text = e.target.value;
      if (e.target.classList.contains("time")) t.time = e.target.value;
      this.save();
    });
    $("#plan-tasks").addEventListener("change", e => {
      if (e.target.type !== "checkbox") return; const row = e.target.closest(".task");
      this.data.tasks[+row.dataset.i].done = e.target.checked; this.renderTasks(); this.save();
    });
    $("#plan-tasks").addEventListener("click", e => {
      if (!e.target.classList.contains("x")) return; const row = e.target.closest(".task");
      this.data.tasks.splice(+row.dataset.i, 1); this.renderTasks(); this.save();
    });
    $("#plan-blocks").addEventListener("input", e => {
      const h = +e.target.dataset.h; const blocks = this.data.blocks;
      const b = blocks.find(x => x.h === h);
      if (e.target.value.trim()) { if (b) b.text = e.target.value; else blocks.push({ h, text: e.target.value }); }
      else if (b) blocks.splice(blocks.indexOf(b), 1);
      this.save();
    });
  },
};
views.planner = Planner;

// ═════════════════════════════════════════════════════════════════════════════
// Organizer (Keep-style cards)
// ═════════════════════════════════════════════════════════════════════════════
const Organizer = {
  data: { cards: [] },
  async open() { this.data = await api("GET", "organizer"); this.render(); },
  save: debounce(function () { api("PUT", "organizer", Organizer.data); }, 500),
  render() {
    const q = $("#org-search").value.trim().toLowerCase();
    const cards = this.data.cards.filter(c => !q || (c.title + " " + c.text + " " + (c.items || []).map(i => i.text).join(" ")).toLowerCase().includes(q))
      .sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
    $("#org-board").innerHTML = cards.length ? cards.map(c => `
      <div class="kcard" data-id="${esc(c.id)}" data-color="${esc(c.color || "")}">
        <button class="icon-btn pin ${c.pinned ? "on" : ""}" data-act="pin" title="Pin">${c.pinned ? "keep" : "keep_off"}</button>
        <input class="ttl" value="${esc(c.title)}" placeholder="Title" data-f="title">
        ${c.items ? c.items.map((it, i) => `<div class="item ${it.done ? "done" : ""}"><input type="checkbox" data-i="${i}" ${it.done ? "checked" : ""}>
            <input type="text" value="${esc(it.text)}" data-i="${i}"></div>`).join("") +
            `<div class="item"><span class="muted">＋</span><input type="text" data-new="1" placeholder="List item"></div>`
          : `<textarea data-f="text" rows="${Math.min(12, (c.text || "").split("\n").length + 1)}" placeholder="Note">${esc(c.text)}</textarea>`}
        <div class="actions">
          ${["", "blue", "amber", "red", "green", "violet"].map(col => `<button class="dot" data-act="color" data-color="${col}" title="${col || "no color"}"
             style="background:${{ "": "var(--surface-2)", blue: "#6aa5ff", amber: "#f2c66d", red: "#ff8f87", green: "#8fd6a6", violet: "#c5a3ff" }[col]}"></button>`).join("")}
          <span class="grow"></span>
          <button class="icon-btn" data-act="delete" title="Delete card">delete</button>
        </div>
      </div>`).join("") : `<div class="empty">No cards. Take a note above.</div>`;
  },
  card(el) { return this.data.cards.find(c => c.id === el.closest(".kcard").dataset.id); },
  add(kind) {
    const title = $("#org-new-title").value.trim();
    this.data.cards.push({ id: Math.random().toString(36).slice(2, 10), title, text: "", color: "", pinned: false,
      items: kind === "list" ? [] : undefined, updated: Date.now() / 1000 });
    $("#org-new-title").value = ""; this.render(); this.save();
    $("#org-board .kcard:first-child " + (kind === "list" ? "input[data-new]" : "textarea"))?.focus();
  },
  init() {
    $("#org-new-note").onclick = () => this.add("note");
    $("#org-new-list").onclick = () => this.add("list");
    $("#org-new-title").addEventListener("keydown", e => { if (e.key === "Enter") this.add("note"); });
    $("#org-search").addEventListener("input", () => this.render());
    const board = $("#org-board");
    board.addEventListener("input", e => {
      const c = this.card(e.target); c.updated = Date.now() / 1000;
      if (e.target.dataset.f) c[e.target.dataset.f] = e.target.value;
      else if (e.target.type === "text" && e.target.dataset.i !== undefined) c.items[+e.target.dataset.i].text = e.target.value;
      this.save();
    });
    board.addEventListener("keydown", e => {
      if (e.key === "Enter" && e.target.dataset.new && e.target.value.trim()) {
        const c = this.card(e.target); c.items.push({ text: e.target.value.trim(), done: false });
        this.render(); this.save(); $(`.kcard[data-id="${c.id}"] input[data-new]`).focus();
      }
    });
    board.addEventListener("change", e => {
      if (e.target.type !== "checkbox") return; const c = this.card(e.target);
      c.items[+e.target.dataset.i].done = e.target.checked; this.render(); this.save();
    });
    board.addEventListener("click", e => {
      const act = e.target.dataset.act; if (!act) return; const c = this.card(e.target);
      if (act === "pin") c.pinned = !c.pinned;
      if (act === "color") c.color = e.target.dataset.color;
      if (act === "delete") { if (!confirm("Delete this card?")) return; this.data.cards = this.data.cards.filter(x => x !== c); }
      this.render(); this.save();
    });
  },
};
views.organizer = Organizer;

// ═════════════════════════════════════════════════════════════════════════════
// Research journal
// ═════════════════════════════════════════════════════════════════════════════
const Journal = {
  date: today(), dates: [], previewOn: true,
  async open() { await this.list(); await this.load(this.date); },
  async list() {
    this.dates = await api("GET", "journal");
    const all = [...new Set([today(), ...this.dates])].sort().reverse();
    $("#journal-list").innerHTML = all.map(d => `<div class="jday ${d === this.date ? "on" : ""}" data-d="${d}">
      ${new Date(d + "T00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
      ${this.dates.includes(d) ? "" : `<span class="muted">· new</span>`}</div>`).join("");
  },
  async load(d, direction) {
    await this.flush();
    const page = $("#jpage");
    if (direction && settings.pageFlip !== false) { page.className = "out-" + direction; await new Promise(r => setTimeout(r, 260)); }
    this.date = d;
    const r = await api("GET", "journal/" + d);
    $("#journal-editor").value = r.content;
    $("#journal-title").textContent = new Date(d + "T00:00").toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (direction) { page.className = ""; void page.offsetWidth; page.className = "in-" + direction; }
    $$(".jday").forEach(x => x.classList.toggle("on", x.dataset.d === d));
    this.render();
  },
  dirty: false,
  async flush() {
    if (!this.dirty) return; this.dirty = false;
    await api("PUT", "journal/" + this.date, { content: $("#journal-editor").value });
    $("#journal-save").textContent = "saved";
    if (!this.dates.includes(this.date)) this.list();
  },
  render: debounce(async function () {
    if (!Journal.previewOn) return;
    await Journal.flush();
    const r = await api("GET", `journal/${Journal.date}/render`);
    $("#journal-preview").innerHTML = r.html || `<div class="empty">Write something on the left</div>`;
  }, 600),
  init() {
    const ed = $("#journal-editor");
    const save = debounce(() => this.flush(), 700);
    ed.addEventListener("input", () => { this.dirty = true; $("#journal-save").textContent = "…"; save(); this.render(); });
    $("#journal-list").addEventListener("click", e => {
      const d = e.target.closest(".jday")?.dataset.d; if (d && d !== this.date) this.load(d, d < this.date ? "prev" : "next");
    });
    $("#journal-today").onclick = () => this.load(today(), "next");
    $("#journal-template").onclick = () => {
      const t = `## Goal\n\n\n## What I did\n- \n\n## Results\n\n\n## Problems / questions\n- \n\n## Next steps\n- [ ] \n\n## Ideas\n`;
      ed.value = (ed.value.trim() ? ed.value.trimEnd() + "\n\n" : "") + t; this.dirty = true; save(); this.render(); ed.focus();
    };
    $("#journal-preview-btn").onclick = () => {
      this.previewOn = !this.previewOn; $("#journal-preview").style.display = this.previewOn ? "" : "none";
      $("#journal-preview-btn").classList.toggle("on", this.previewOn); this.render();
    };
  },
};
views.journal = Journal;

// ═════════════════════════════════════════════════════════════════════════════
// Reminders (same file as the bar calendar)
// ═════════════════════════════════════════════════════════════════════════════
const Reminders = {
  items: [], editing: null,
  async open() { $("#rem-date").value ||= today(); this.items = await api("GET", "reminders"); this.render(); },
  render() {
    const now = new Date(); const when = r => new Date(`${r.date}T${r.time}`);
    const groups = [
      ["Today", this.items.filter(r => r.date === today() && when(r) >= now && !r.fired)],
      ["Upcoming", this.items.filter(r => r.date > today() && !r.fired)],
      ["Done / past", this.items.filter(r => r.fired || when(r) < now).reverse()],
    ];
    $("#rem-list").innerHTML = groups.filter(g => g[1].length).map(([name, list]) => `<div class="rem-group"><h3>${name}</h3>${list.map(r =>
      this.editing === r.id ? `
        <div class="rem" data-id="${r.id}">
          <input class="field" type="date" value="${r.date}" data-f="date"><input class="field" type="time" value="${r.time}" data-f="time">
          <input class="field txt" value="${esc(r.text)}" data-f="text">
          <button class="btn primary" data-act="save">Save</button><button class="btn ghost" data-act="cancel">Cancel</button>
        </div>` : `
        <div class="rem ${r.fired ? "past" : ""}" data-id="${r.id}">
          <span class="when">${new Date(r.date + "T00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${r.time}</span>
          <span class="txt">${esc(r.text)}</span>
          <button class="icon-btn" data-act="edit" title="Edit">edit</button>
          <button class="icon-btn" data-act="delete" title="Delete">delete</button>
        </div>`).join("")}</div>`).join("") || `<div class="empty">No reminders. Add one above, or from the calendar in the bar.</div>`;
  },
  init() {
    const add = async () => {
      const text = $("#rem-text").value.trim(); if (!text) return $("#rem-text").focus();
      await api("POST", "reminders", { date: $("#rem-date").value, time: $("#rem-time").value, text });
      $("#rem-text").value = ""; toast("Reminder set"); this.open();
    };
    $("#rem-add").onclick = add;
    $("#rem-text").addEventListener("keydown", e => { if (e.key === "Enter") add(); });
    $("#rem-list").addEventListener("click", async e => {
      const act = e.target.dataset.act; if (!act) return; const row = e.target.closest(".rem"); const id = row.dataset.id;
      if (act === "edit") { this.editing = id; this.render(); }
      if (act === "cancel") { this.editing = null; this.render(); }
      if (act === "delete") { await api("DELETE", "reminders/" + id); this.open(); }
      if (act === "save") {
        const patch = {}; $$("[data-f]", row).forEach(i => patch[i.dataset.f] = i.value);
        await api("PUT", "reminders/" + id, patch); this.editing = null; toast("Reminder updated"); this.open();
      }
    });
  },
};
views.reminders = Reminders;

// ═════════════════════════════════════════════════════════════════════════════
// Git center
// ═════════════════════════════════════════════════════════════════════════════
const Git = {
  repos: [], idx: 0, status: null,
  async open() {
    this.repos = await api("GET", "git");
    $("#repo-list").innerHTML = this.repos.map((r, i) => `<div class="repo ${i === this.idx ? "on" : ""}" data-i="${i}">
      <div class="n">${esc(r.name)}</div><div class="s">${esc(r.path.replace(/^\/home\/[^/]+/, "~"))}</div></div>`).join("");
    await this.load(this.idx);
  },
  async load(i) {
    this.idx = i; const repo = this.repos[i];
    $$(".repo").forEach(r => r.classList.toggle("on", +r.dataset.i === i));
    $("#git-title").textContent = repo.name;
    $("#git-scan").style.display = repo.system ? "" : "none";
    const s = this.status = await api("GET", `git/${i}/status`);
    $("#git-branch").textContent = `⎇ ${s.branch}` + (s.remote ? ` · ${s.ahead}↑ ${s.behind}↓` : " · no remote yet");
    $("#git-files").innerHTML = s.files.length ? s.files.map(f => `<div class="gfile" data-f="${esc(f.path)}">
      <span class="st ${esc(f.status[0])}">${esc(f.status)}</span><span>${esc(f.path)}</span></div>`).join("")
      : `<div class="empty">Nothing changed since the last commit</div>`;
    $("#git-diff").innerHTML = `<span class="empty">${s.files.length ? "Select a file to see what changed" : "Clean ✓"}</span>`;
    $("#git-log").innerHTML = s.log.map(l => `${esc(l.hash)}  ${esc(l.when.padEnd(16))} ${esc(l.msg)}`).join("<br>") || "no commits yet";
  },
  async diff(file) {
    $$(".gfile").forEach(f => f.classList.toggle("on", f.dataset.f === file));
    const r = await api("GET", `git/${this.idx}/diff?file=${encodeURIComponent(file)}`);
    $("#git-diff").innerHTML = r.diff ? r.diff.split("\n").map(l =>
      `<span class="${l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : ""}">${esc(l)}</span>`).join("\n")
      : `<span class="empty">No text diff (binary or empty)</span>`;
  },
  async act(action, body) {
    toast(action + "…");
    const r = await api("POST", `git/${this.idx}/${action}`, body || {});
    toast(r.ok ? action + " done ✓" : action + " failed: see details", r.ok ? 2000 : 4000);
    if (!r.ok || action !== "commit") $("#git-diff").textContent = r.log || "";
    await this.load(this.idx);
    if (!r.ok) $("#git-diff").textContent = r.log || "";
  },
  init() {
    $("#repo-list").addEventListener("click", e => { const r = e.target.closest(".repo"); if (r) this.load(+r.dataset.i); });
    $("#git-files").addEventListener("click", e => { const f = e.target.closest(".gfile"); if (f) this.diff(f.dataset.f); });
    $("#git-commit").onclick = async () => { await this.act("commit", { message: $("#git-msg").value }); $("#git-msg").value = ""; };
    $("#git-pull").onclick = () => this.act("pull");
    $("#git-push").onclick = () => this.act("push");
    $("#git-scan").onclick = () => this.act("refresh-system");
  },
};
views.git = Git;

// ═════════════════════════════════════════════════════════════════════════════
// Settings
// ═════════════════════════════════════════════════════════════════════════════
views.settings = {
  open() {
    $("#set-theme").value = settings.theme; $("#set-font").value = settings.editorFont === "Latin Modern Mono" ? "LM Mono Light" : settings.editorFont;
    $("#set-pfont").value = settings.previewFont; $("#set-size").value = settings.fontSize; $("#set-size-v").textContent = settings.fontSize + " px";
    $("#set-lh").value = settings.lineHeight; $("#set-lh-v").textContent = settings.lineHeight; $("#set-flip").checked = settings.pageFlip !== false;
  },
  init() {
    $("#set-theme").onchange = e => saveSettings({ theme: e.target.value });
    $("#set-font").onchange = e => saveSettings({ editorFont: e.target.value });
    $("#set-pfont").onchange = e => saveSettings({ previewFont: e.target.value });
    $("#set-size").oninput = e => { $("#set-size-v").textContent = e.target.value + " px"; saveSettings({ fontSize: +e.target.value }); };
    $("#set-lh").oninput = e => { $("#set-lh-v").textContent = e.target.value; saveSettings({ lineHeight: +e.target.value }); };
    $("#set-flip").onchange = e => saveSettings({ pageFlip: e.target.checked });
  },
};

// ── Greek & special characters ───────────────────────────────────────────────
const Chars = {
  sets: {
    "greek": "α β γ δ ε ϵ ζ η θ ϑ ι κ λ μ ν ξ π ϖ ρ ϱ σ ς τ υ φ ϕ χ ψ ω",
    "GREEK": "Α Β Γ Δ Ε Ζ Η Θ Ι Κ Λ Μ Ν Ξ Π Ρ Σ Τ Υ Φ Χ Ψ Ω",
    "math": "± ∓ × ÷ · ∘ √ ∛ ∞ ∝ ∑ ∏ ∫ ∬ ∮ ∂ ∇ ∆ ≈ ≃ ≅ ≡ ≠ ≤ ≥ ≪ ≫ ∼ ′ ″ ° ‰ ∠ ⊥ ∥",
    "physics": "ℏ ħ ⟨ ⟩ | † ⊗ ⊕ ⊙ ℒ ℋ ℰ ℱ ℓ Å µ Ω ε₀ μ₀ k_B ⟂ ∇² □ ∂μ Γ",
    "sets": "∈ ∉ ∋ ⊂ ⊃ ⊆ ⊇ ∪ ∩ ∅ ℕ ℤ ℚ ℝ ℂ ∀ ∃ ∄ ¬ ∧ ∨ ⊢ ⊨ ∴ ∵",
    "arrows": "→ ← ↔ ⇒ ⇐ ⇔ ↦ ↑ ↓ ⇌ ⟶ ⟵ ⟹ ↗ ↘ ↺ ↻",
    "super/sub": "⁰ ¹ ² ³ ⁴ ⁵ ⁶ ⁷ ⁸ ⁹ ⁺ ⁻ ⁿ ₀ ₁ ₂ ₃ ₄ ₅ ₆ ₇ ₈ ₉ ₊ ₋ ₙ ᵢ ⱼ",
    "misc": "… • † ‡ § ¶ © ® ™ ✓ ✗ ★ ☆ ♠ ♥ ♦ ♣ ☀ ☾ € £ ¥ ₹",
  },
  tab: "greek",
  open(on) { $("#chars").classList.toggle("open", on ?? !$("#chars").classList.contains("open")); },
  render() {
    $("#chars-tabs").innerHTML = Object.keys(this.sets).map(k => `<button class="chip ${k === this.tab ? "on" : ""}" data-t="${k}">${k}</button>`).join("");
    $("#chars-grid").innerHTML = this.sets[this.tab].split(" ").map(c => `<button title="${c}">${c}</button>`).join("");
  },
  insert(ch) {
    if (Notes.current?.type === "keep") { if (!Scratch.insertChar(ch)) toast("Click into a block first, then pick a character"); }
    else if (Notes.current && Notes.current.type !== "pdf") Notes.insert(ch);
  },
  init() {
    this.render();
    $("#chars-tabs").onclick = e => { const t = e.target.dataset.t; if (t) { this.tab = t; this.render(); } };
    $("#chars-grid").onmousedown = e => e.preventDefault();
    $("#chars-grid").onclick = e => { if (e.target.tagName === "BUTTON") this.insert(e.target.textContent); };
    $("#chars-close").onclick = () => this.open(false);
    ["#tb-chars", "#tb-chars2"].forEach(id => { $(id).onmousedown = e => e.preventDefault(); $(id).onclick = () => this.open(); });
  },
};

// ── sync with the phone: status in the rail, reload what changed ─────────────
const Sync = {
  rev: null, busy: false,
  icon(st) {
    const b = $("#sync-toggle"), ic = $("#sync-toggle .ms");
    b.classList.toggle("spin", !!this.busy);
    if (!st.remote) { ic.textContent = "cloud_off"; b.title = $("#set-sync-st").textContent = "No GitHub remote set up for ~/gaussian_keep"; return; }
    ic.textContent = this.busy ? "sync" : !st.ok ? "sync_problem" : st.ahead ? "cloud_upload" : "cloud_done";
    b.title = !st.ok ? "Last sync had a problem: open the Git tab\n" + (st.log || "")
      : `Synced with the phone${st.last ? " · " + new Date(st.last * 1000).toLocaleTimeString() : ""}${st.ahead ? ` · ${st.ahead} to upload` : ""}`;
    $("#set-sync-st").textContent = this.busy ? "syncing…" : !st.ok ? "last sync had a problem (see the Git tab)"
      : `automatic via GitHub${st.last ? ", last at " + new Date(st.last * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}${st.ahead ? ` · ${st.ahead} to upload` : " · up to date"}`;
  },
  async poll(force) {
    try {
      if (force) { this.busy = true; this.icon({ remote: true, ok: true }); }
      const st = await api(force ? "POST" : "GET", "sync");
      this.busy = false; this.icon(st);
      if (this.rev !== null && st.rev !== this.rev) { refreshActive(); toast("Updated from the phone"); }
      else if (force) toast(st.ok ? "In sync with the phone" : "Sync problem: see the Git tab");
      this.rev = st.rev;
    } catch (e) { this.busy = false; }
  },
  init() {
    $("#sync-toggle").onclick = $("#set-sync").onclick = () => this.poll(true);
    this.poll(); setInterval(() => this.poll(), 8000);
  },
};

// reload the visible section after the phone changed things; never under your fingers
function refreshActive() {
  const typing = () => { const a = document.activeElement; return a && (a.isContentEditable || /^(TEXTAREA|INPUT)$/.test(a.tagName)); };
  const view = ($(".view.on")?.id || "").replace("view-", "");
  if (view === "notes") {
    Notes.refresh().then(() => {
      if (Notes.current && !Notes.dirty && !typing()) Notes.load(Notes.current.id).catch(() => { Notes.current = null; });
    });
  }
  else if (view === "planner" && !typing()) Planner.load(Planner.date);
  else if (view === "organizer" && !typing()) Organizer.open();
  else if (view === "journal" && !typing() && !Journal.dirty) Journal.open();
  else if (view === "reminders" && !Reminders.editing) Reminders.open();
  else if (view === "git") Git.open();
}

// ── keyboard ─────────────────────────────────────────────────────────────────
document.addEventListener("keydown", e => {
  const order = ["notes", "planner", "organizer", "journal", "reminders", "git"];
  if (e.ctrlKey && /^[1-6]$/.test(e.key)) { e.preventDefault(); show(order[+e.key - 1]); }
  if (e.ctrlKey && e.key === ",") { e.preventDefault(); show("settings"); }
  const inNotes = $("#view-notes").classList.contains("on");
  if (!inNotes) return;
  if (e.ctrlKey && e.key === "s") { e.preventDefault(); Notes.dirty = true; Notes.save(); }
  if (e.ctrlKey && e.key === "Enter" && !e.target.closest?.("#sb")) { e.preventDefault(); Notes.compile(); }
  if (e.ctrlKey && e.key === "n") { e.preventDefault(); Notes.create("md"); }
  if (e.ctrlKey && e.key === "p") { e.preventDefault(); $("#note-search").focus(); }
  if (e.key === "F11") { e.preventDefault(); Notes.focusMode(); }
  if (e.key === "Escape" && document.body.classList.contains("focus")) Notes.focusMode(false);
  if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); Notes.flip(1); }
  if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); Notes.flip(-1); }
});
window.addEventListener("beforeunload", () => { Notes.save(); Journal.flush(); });

// ── start ────────────────────────────────────────────────────────────────────
(async function start() {
  settings = await api("GET", "settings"); applySettings();
  [Notes, Planner, Organizer, Journal, Reminders, Git, views.settings, Chars, Sync].forEach(v => v.init());
  $$("#sb-toolbar [data-sb]").forEach(b => { b.onmousedown = e => e.preventDefault(); b.onclick = () => Scratch.add(b.dataset.sb); });
  if (innerWidth < 1100) { Notes.previewOn = false; $("#preview-pane").classList.add("hidden"); $("#tb-preview").classList.remove("on"); }
  $$("#rail button[data-view]").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));
  $("#theme-toggle").onclick = () => saveSettings({ theme: settings.theme === "light" ? "dark" : "light" });
  show(location.hash.slice(1) || "notes");
})();
