// Scratchbook: one continuous page. Click anywhere and write; a line's $LaTeX$
// turns into typeset maths as soon as the cursor leaves it (Enter or click away).
// Click typeset maths to get the $…$ source back.
//
// Paragraphs are plain editable text. Tables, display equations, code, sketches,
// quotes, images and dividers are "islands" inserted from the toolbar (or by
// typing $$…$$, # , ```lang, ---, > , or / on an empty line, then Enter).
"use strict";

const Scratch = (() => {
  let root = null, docEl = null, onChange = () => {}, title = "";
  const blocks = new Map();             // island id → block object (tables, code, …)
  const cache = new Map();
  let queue = [], queueTimer = null;
  let curPara = null, savedRange = null, lastField = null;
  const uid = () => Math.random().toString(36).slice(2, 10);
  const changed = () => { onChange(); refreshRefs(); };

  // ── rendering through the backend (pandoc), batched ────────────────────────
  function rendered(kind, text, lang = "") {
    const key = kind + "\u0001" + lang + "\u0001" + text;
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    return new Promise(res => {
      queue.push({ key, item: { kind, text, lang }, res });
      clearTimeout(queueTimer); queueTimer = setTimeout(flush, 20);
    });
  }
  async function flush() {
    const batch = queue; queue = [];
    if (!batch.length) return;
    try {
      const r = await api("POST", "render", { items: batch.map(b => b.item) });
      batch.forEach((b, i) => { cache.set(b.key, r.html[i] || ""); b.res(r.html[i] || ""); });
    } catch (e) { batch.forEach(b => b.res(`<span class="sb-hint">render failed</span>`)); }
  }

  // ── inline Markdown ⇄ DOM (paragraphs) ─────────────────────────────────────
  // supported inline: $math$, **bold**, *italic*, `code`; line breaks inside a paragraph
  const INLINE = /(\$[^$\n]+?\$)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(`[^`\n]+?`)/g;
  function fillInline(p, md) {
    p.textContent = "";
    if (!md) { p.append(document.createElement("br")); return; }
    md.split("\n").forEach((line, li) => {
      if (li) p.append(document.createElement("br"));
      let last = 0;
      for (const m of line.matchAll(INLINE)) {
        if (m.index > last) p.append(line.slice(last, m.index));
        const tok = m[0];
        if (m[1]) p.append(mathSpan(tok.slice(1, -1)));
        else if (m[2]) { const b = el("b"); b.textContent = tok.slice(2, -2); p.append(b); }
        else if (m[3]) { const i = el("i"); i.textContent = tok.slice(1, -1); p.append(i); }
        else { const c = el("code"); c.textContent = tok.slice(1, -1); p.append(c); }
        last = m.index + tok.length;
      }
      if (last < line.length) p.append(line.slice(last));
    });
  }
  function mathSpan(tex) {
    const s = el("span", "m"); s.contentEditable = "false"; s.dataset.tex = tex; s.title = "click to edit";
    s.textContent = tex;
    rendered("inline", "$" + tex + "$").then(h => { if (h) s.innerHTML = h; });
    return s;
  }
  function serializeInline(node) {
    let out = "";
    node.childNodes.forEach(n => {
      if (n.nodeType === 3) out += n.data.replace(/ /g, " ");
      else if (n.nodeType !== 1) return;
      else if (n.classList.contains("m")) out += "$" + n.dataset.tex + "$";
      else if (n.tagName === "BR") out += "\n";
      else if (n.tagName === "B" || n.tagName === "STRONG") out += "**" + serializeInline(n) + "**";
      else if (n.tagName === "I" || n.tagName === "EM") out += "*" + serializeInline(n) + "*";
      else if (n.tagName === "CODE") out += "`" + n.textContent + "`";
      else if (n.tagName === "DIV" || n.tagName === "P") out += (out ? "\n" : "") + serializeInline(n);
      else out += serializeInline(n);
    });
    return out;
  }
  const trimBr = s => s.replace(/\n+$/, "");

  // ── document build / serialize ─────────────────────────────────────────────
  const isIsland = n => n?.classList?.contains("sb-island");
  const isText = n => n && n.nodeType === 1 && !isIsland(n);
  function para(md = "") { const p = el("p"); fillInline(p, md); return p; }
  function headingEl(text, level) { const h = el("h" + Math.min(3, Math.max(1, level))); h.textContent = text; return h; }

  function build(data) {
    root.innerHTML = "";
    const inner = el("div", "sb-inner");
    const t = el("input", "sb-title"); t.placeholder = "Untitled"; t.value = title = data.title || "";
    t.oninput = () => { title = t.value; onChange(); };
    t.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); caretTo(docEl.firstElementChild, "start"); } };
    docEl = el("div", "sb-doc"); docEl.contentEditable = "true"; docEl.spellcheck = false;
    blocks.clear();
    (data.blocks || []).forEach(b => {
      if (b.type === "text") docEl.append(para(b.md || ""));
      else if (b.type === "heading") docEl.append(headingEl(b.text || "", b.level || 2));
      else docEl.append(island(b));
    });
    ensureTrailingPara();
    inner.append(t, docEl, el("div", "sb-refs"));
    root.append(inner);
    wire();
    refreshRefs();
  }

  function serialize() {
    const out = [];
    [...docEl.children].forEach(n => {
      if (isIsland(n)) { const b = blocks.get(n.dataset.id); if (b) { const { id, ...rest } = b; out.push(rest); } }
      else if (/^H[1-3]$/.test(n.tagName)) out.push({ type: "heading", text: n.textContent, level: +n.tagName[1] });
      else {
        const md = trimBr(serializeInline(n));
        // empty lines that only exist so the caret can sit between blocks are not saved
        const spacer = !md.trim() && (!n.previousElementSibling || isIsland(n.previousElementSibling))
                                  && (!n.nextElementSibling || isIsland(n.nextElementSibling));
        if (!spacer) out.push({ type: "text", md });
      }
    });
    while (out.length > 1 && out[out.length - 1].type === "text" && !out[out.length - 1].md.trim()) out.pop();
    return { title, blocks: out };
  }

  function ensureTrailingPara() {
    if (!docEl.lastElementChild || isIsland(docEl.lastElementChild)) docEl.append(para());
    // islands next to each other get an empty line between them, so the caret can go there
    [...docEl.children].forEach(n => { if (isIsland(n) && isIsland(n.nextElementSibling)) n.after(para()); });
    if (isIsland(docEl.firstElementChild)) docEl.prepend(para());
  }

  // ── caret helpers ──────────────────────────────────────────────────────────
  function topLevel(node) {
    while (node && node.parentNode !== docEl) node = node.parentNode;
    return node && node.parentNode === docEl ? node : null;
  }
  function caretTo(node, where = "end") {
    if (!node) return;
    if (isIsland(node)) { const p = para(); node.after(p); node = p; }
    docEl.focus();
    const r = document.createRange(); r.selectNodeContents(node); r.collapse(where === "start");
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function currentTop() {
    const s = getSelection();
    return s.rangeCount && docEl.contains(s.anchorNode) ? topLevel(s.anchorNode) : null;
  }

  // ── conversion when the caret leaves a line ────────────────────────────────
  function convert(p) {
    if (!p || !docEl.contains(p) || isIsland(p) || /^H[1-3]$/.test(p.tagName)) return;
    const md = trimBr(serializeInline(p)), s = md.trim();
    let m;
    if ((m = s.match(/^\$\$([\s\S]+?)\$\$$/))) return replaceWithIsland(p, make.math(m[1].trim()));
    if ((m = s.match(/^(#{1,3})\s+(.+)$/)) && !s.includes("\n")) { const h = headingEl(m[2], m[1].length); p.replaceWith(h); changed(); return; }
    if ((m = s.match(/^```(\w*)$/))) return replaceWithIsland(p, make.code("", m[1] || "python"), true);
    if (s === "---") return replaceWithIsland(p, make.divider());
    if (s.startsWith("> ")) return replaceWithIsland(p, make.quote(s.slice(2)));
    // re-render inline maths / emphasis only when there is something to render
    if (/\$[^$]+\$|\*|`/.test(md) || p.querySelector("div, span:not(.m), font")) { fillInline(p, md); }
  }

  function wire() {
    document.execCommand("defaultParagraphSeparator", false, "p");
    const inIsland = e => !!e.target.closest?.(".sb-island");
    docEl.addEventListener("input", e => { onChange(); if (!inIsland(e)) slashCheck(); });
    // Enter: typeset the line being finished right away. selectionchange alone can miss it
    // when input arrives in one burst (fast typing, phone keyboards batching keystrokes).
    docEl.addEventListener("beforeinput", e => {
      if (inIsland(e) || e.inputType !== "insertParagraph") return;
      const line = currentTop();
      if (line && !isIsland(line)) setTimeout(() => { if (curPara !== line || !line.contains(getSelection().anchorNode)) convert(line); }, 0);
    });
    docEl.addEventListener("keydown", e => {
      if (inIsland(e)) return;          // tables, code, equations handle their own keys
      if (menuOpen && ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(e.key)) return menuKey(e);
      if (e.key === "Tab") { e.preventDefault(); document.execCommand("insertText", false, "    "); }
      if (e.key === "Backspace") {   // remove an island that sits right before an empty line
        const t = currentTop(), s = getSelection();
        if (t && !isIsland(t) && s.isCollapsed && atStart(t, s) && isIsland(t.previousElementSibling)) {
          e.preventDefault();
          const isl = t.previousElementSibling;
          if (isl.classList.contains("armed")) { removeIsland(isl); } else { isl.classList.add("armed"); setTimeout(() => isl.classList.remove("armed"), 1500); toast("Backspace again to delete that block", 1200); }
        }
      }
    });
    // paste plain text only (keeps the page clean)
    docEl.addEventListener("paste", e => {
      if (inIsland(e)) return;
      const txt = e.clipboardData?.getData("text/plain"); if (txt == null) return;
      e.preventDefault();
      if (/\t/.test(txt) && txt.trim().includes("\n")) { csvDialog(txt); return; }   // spreadsheet cells → table
      document.execCommand("insertText", false, txt);
    });
    // click typeset maths → back to $…$ source with the caret inside
    docEl.addEventListener("mousedown", e => {
      const m = e.target.closest?.(".m"); if (!m || !docEl.contains(m)) return;
      e.preventDefault();
      const txt = document.createTextNode("$" + m.dataset.tex + "$");
      m.replaceWith(txt);
      docEl.focus();
      const r = document.createRange(); r.setStart(txt, txt.length - 1); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      curPara = topLevel(txt);
    });
    // whitespace around the page: put the caret at the end
    root.onmousedown = e => {
      if (e.target === root || e.target.classList?.contains("sb-inner") || e.target.classList?.contains("sb-refs")) {
        e.preventDefault(); ensureTrailingPara(); caretTo(docEl.lastElementChild, "end");
      }
    };
    document.addEventListener("selectionchange", onSelection);
  }
  function onSelection() {
    if (!docEl || !document.contains(docEl)) return document.removeEventListener("selectionchange", onSelection);
    const s = getSelection();
    if (!s.rangeCount) return;
    if (docEl.contains(s.anchorNode)) {
      savedRange = s.getRangeAt(0).cloneRange(); lastField = docEl;
      const t = topLevel(s.anchorNode);
      if (t !== curPara) { const prev = curPara; curPara = t; if (prev) convert(prev); }
    } else if (curPara && !root.contains(s.anchorNode)) { const prev = curPara; curPara = null; convert(prev); }
  }
  function atStart(node, s) {
    const r = document.createRange(); r.selectNodeContents(node); r.setEnd(s.anchorNode, s.anchorOffset);
    return r.toString().length === 0;
  }

  // ── islands ───────────────────────────────────────────────────────────────
  const make = {
    heading: () => null,
    math: (tex = "") => ({ type: "math", tex }),
    table: (rows = [["Quantity", "Symbol", "Value"], ["", "", ""], ["", "", ""]]) => ({ type: "table", rows, head: true, caption: "" }),
    code: (code = "", lang = "python") => ({ type: "code", code, lang }),
    sketch: () => ({ type: "sketch", h: 280, shapes: [] }),
    quote: (text = "", ref = null) => ({ type: "quote", text, ref }),
    image: (path, caption = "") => ({ type: "image", path, caption }),
    divider: () => ({ type: "divider" }),
  };
  function island(b) {
    b.id ||= uid(); blocks.set(b.id, b);
    const n = el("div", "sb-island sb-" + b.type); n.contentEditable = "false"; n.dataset.id = b.id;
    const ctl = el("div", "sb-ctl");
    ctl.append(iconBtn("arrow_upward", "Move up", () => moveIsland(n, -1)), iconBtn("arrow_downward", "Move down", () => moveIsland(n, 1)),
      iconBtn("delete", "Delete", () => removeIsland(n)));
    n.append(ctl, (views[b.type] || (() => el("div")))(b, n));
    return n;
  }
  function replaceWithIsland(p, b, edit) {
    const n = island(b); p.replaceWith(n); ensureTrailingPara(); changed();
    if (edit) openIsland(n, b); else caretTo(n.nextElementSibling, "start");
    return n;
  }
  function insertIsland(b, edit = true) {
    let t = currentTop() || (savedRange && topLevel(savedRange.startContainer));
    const n = island(b);
    if (t && !isIsland(t) && !trimBr(serializeInline(t)).trim()) t.replaceWith(n);      // empty line → becomes the block
    else if (t) t.after(n);
    else docEl.lastElementChild ? docEl.lastElementChild.after(n) : docEl.append(n);
    ensureTrailingPara(); changed();
    if (edit) openIsland(n, b); else caretTo(n.nextElementSibling, "start");
    n.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return n;
  }
  function openIsland(n, b) {
    if (b.type === "table") n.querySelector("td")?.focus();
    else if (b.type === "code") n.querySelector(".sb-code-body")?.dispatchEvent(new MouseEvent("click"));
    else if (b.type === "math") n.querySelector(".sb-math")?.click();
    else if (b.type === "quote") n.querySelector("textarea")?.focus();
  }
  function removeIsland(n) {
    const next = n.nextElementSibling; blocks.delete(n.dataset.id); n.remove(); ensureTrailingPara(); changed();
    caretTo(next && !isIsland(next) ? next : docEl.lastElementChild, "start");
  }
  function moveIsland(n, step) {
    const sib = step < 0 ? n.previousElementSibling : n.nextElementSibling; if (!sib) return;
    step < 0 ? sib.before(n) : sib.after(n); ensureTrailingPara(); changed();
  }
  function rebuildIsland(b) {
    const old = docEl.querySelector(`.sb-island[data-id="${b.id}"]`); if (!old) return null;
    const n = island(b); old.replaceWith(n); changed(); return n;
  }
  function leaveIsland(n) { caretTo(n.nextElementSibling && !isIsland(n.nextElementSibling) ? n.nextElementSibling : null, "start"); }

  // ── island views ──────────────────────────────────────────────────────────
  const views = {
    divider() { return el("hr", "sb-divider"); },
    image(b) {
      const f = el("figure", "sb-image"); f.style.margin = "8px 0";
      const img = el("img"); img.src = window.keepFileUrl ? window.keepFileUrl(b.path) : "/files/notes/" + b.path;
      const cap = el("input", "sb-caption"); cap.placeholder = "Caption"; cap.value = b.caption || "";
      cap.oninput = () => { b.caption = cap.value; changed(); }; cap.onfocus = () => lastField = cap;
      f.append(img, cap); return f;
    },
    math(b, n) {
      const v = el("div", "sb-math");
      const show = () => { if (b.tex.trim()) rendered("math", b.tex).then(h => v.innerHTML = h); else v.innerHTML = `<span class="empty">empty equation: click to write LaTeX</span>`; };
      v.onclick = () => {
        if (v.querySelector("textarea")) return;
        const t = el("textarea", "sb-edit"); t.value = b.tex; t.rows = 1; t.spellcheck = false; t.placeholder = "LaTeX, e.g. \\hat H|\\psi\\rangle = E|\\psi\\rangle";
        const live = el("div", "sb-live"); v.innerHTML = ""; v.append(t, live); autosize(t); t.focus(); lastField = t;
        const prev = () => rendered("math", t.value).then(h => live.innerHTML = h || "");
        t.oninput = () => { b.tex = t.value; autosize(t); changed(); clearTimeout(t.tm); t.tm = setTimeout(prev, 220); };
        t.onfocus = () => lastField = t;
        t.onkeydown = e => { if (e.key === "Escape" || (e.key === "Enter" && !e.shiftKey)) { e.preventDefault(); t.blur(); leaveIsland(n); } };
        t.onblur = () => setTimeout(() => { if (!v.contains(document.activeElement)) show(); }, 100);
        prev();
      };
      show(); return v;
    },
    table(b, n) { return tableView(b, n); },
    code(b, n) { return codeView(b, n); },
    sketch(b) { return sketchView(b); },
    quote(b) { return quoteView(b); },
  };

  // ── table ─────────────────────────────────────────────────────────────────
  function tableView(b, n) {
    const box = el("div");
    const wrapT = el("div", "sb-table-wrap");
    const table = el("table", "sb-table" + (b.head ? " has-head" : ""));
    const ncol = Math.max(...b.rows.map(r => r.length));
    b.rows.forEach(r => { while (r.length < ncol) r.push(""); });
    const redo = focusLast => { const nn = rebuildIsland(b); if (focusLast) nn?.querySelector("tr:last-child td")?.focus(); };
    b.rows.forEach((row, ri) => {
      const tr = el("tr");
      row.forEach((_, ci) => {
        const td = el("td"); td.contentEditable = "true"; td.spellcheck = false;
        const show = () => { const v = b.rows[ri][ci]; if (v.trim()) rendered("inline", v).then(h => { if (document.activeElement !== td) td.innerHTML = h; }); else td.textContent = ""; };
        td.onfocus = () => { td.textContent = b.rows[ri][ci]; lastField = td; placeCaretEnd(td); };
        td.onkeyup = td.onclick = () => { lastField = td; };
        td.oninput = () => { b.rows[ri][ci] = td.textContent; changed(); };
        td.onblur = show;
        td.onpaste = e => { e.preventDefault(); document.execCommand("insertText", false, (e.clipboardData.getData("text/plain") || "").replace(/\s*\n\s*/g, " ")); };
        td.onkeydown = e => {
          e.stopPropagation();
          if (e.key === "Tab") {
            e.preventDefault();
            const cells = [...table.querySelectorAll("td")]; const k = cells.indexOf(td) + (e.shiftKey ? -1 : 1);
            if (k >= cells.length) { b.rows.push(Array(ncol).fill("")); redo(true); }
            else cells[Math.max(0, k)]?.focus();
          }
          if (e.key === "Enter") { e.preventDefault(); const down = table.rows[ri + 1]?.cells[ci]; if (down) down.focus(); else { td.blur(); leaveIsland(n); } }
          if (e.key === "Escape") { td.blur(); leaveIsland(n); }
        };
        show(); tr.append(td);
      });
      table.append(tr);
    });
    wrapT.append(table);
    const cap = el("input", "sb-caption"); cap.placeholder = "Table caption (optional)"; cap.value = b.caption || "";
    cap.oninput = () => { b.caption = cap.value; changed(); }; cap.onfocus = () => lastField = cap;
    const tools = el("div", "sb-tools");
    tools.append(
      iconBtn("add_row_below", "Add row", () => { b.rows.push(Array(ncol).fill("")); redo(); }),
      iconBtn("add_column_right", "Add column", () => { b.rows.forEach(r => r.push("")); redo(); }),
      iconBtn("delete_sweep", "Remove last row", () => { if (b.rows.length > 1) b.rows.pop(); redo(); }),
      iconBtn("view_column", "Remove last column", () => { if (ncol > 1) b.rows.forEach(r => r.pop()); redo(); }),
      iconBtn(b.head ? "title" : "format_strikethrough", "Toggle header row", () => { b.head = !b.head; redo(); }),
    );
    box.append(wrapT, cap, tools);
    return box;
  }
  function placeCaretEnd(nd) { const r = document.createRange(); r.selectNodeContents(nd); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }

  // ── code ──────────────────────────────────────────────────────────────────
  const LANGS = ["python", "julia", "c", "cpp", "fortran", "rust", "go", "javascript", "typescript", "java", "bash", "zsh", "matlab",
    "mathematica", "r", "haskell", "lua", "latex", "markdown", "json", "yaml", "toml", "html", "css", "sql", "makefile", "dockerfile", "text"];
  function codeView(b, n) {
    const box = el("div", "sb-code");
    const head = el("div", "sb-code-head");
    const sel = el("select"); LANGS.forEach(l => { const o = el("option"); o.value = l; o.textContent = l; sel.append(o); });
    sel.value = LANGS.includes(b.lang) ? b.lang : "text";
    sel.onchange = () => { b.lang = sel.value; changed(); showCode(); };
    const lang = el("span", "lang"); lang.textContent = "code";
    head.append(lang, sel, el("span", "grow"), iconBtn("content_copy", "Copy code", () => { navigator.clipboard?.writeText(b.code); toast("Code copied"); }));
    const body = el("div", "sb-code-body");
    const showCode = () => {
      if (!b.code.trim()) { body.innerHTML = `<pre class="sb-hint">click to write code…</pre>`; return; }
      rendered("code", b.code, b.lang).then(h => body.innerHTML = h);
    };
    body.onclick = () => {
      if (body.querySelector("textarea")) return;
      const t = el("textarea"); t.value = b.code; t.spellcheck = false;
      body.innerHTML = ""; body.append(t); autosize(t); t.focus(); lastField = t;
      t.oninput = () => { b.code = t.value; autosize(t); changed(); };
      t.onfocus = () => lastField = t;
      t.onkeydown = e => {
        if (e.key === "Tab") { e.preventDefault(); t.setRangeText("    ", t.selectionStart, t.selectionEnd, "end"); t.oninput(); }
        if (e.key === "Escape" || (e.key === "Enter" && e.ctrlKey)) { e.preventDefault(); t.blur(); leaveIsland(n); }
      };
      t.onblur = showCode;
    };
    showCode(); box.append(head, body);
    return box;
  }

  // ── sketch (shapes) ───────────────────────────────────────────────────────
  const COLORS = ["#7fb4ff", "#f2c66d", "#ff8f87", "#8fd6a6", "#c5a3ff", "#e2e2e9", "#5f6b7c"];
  const SHAPES = [["select", "arrow_selector_tool"], ["rect", "rectangle"], ["square", "square"], ["circle", "circle"],
    ["ellipse", "radio_button_unchecked"], ["triangle", "change_history"], ["line", "horizontal_rule"], ["arrow", "arrow_right_alt"], ["text", "title"]];
  function sketchView(b) {
    const box = el("div", "sb-sketch");
    let tool = "rect", color = COLORS[0], fill = false, sel = null;
    const tools = el("div", "sb-sketch-tools");
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg"); svg.setAttribute("viewBox", `0 0 720 ${b.h}`);
    const toolBtns = SHAPES.map(([k, ic]) => { const bt = iconBtn(ic, k, () => { tool = k; toolBtns.forEach(x => x.classList.toggle("on", x === bt)); }); if (k === tool) bt.classList.add("on"); return bt; });
    tools.append(...toolBtns, el("span", "sep"));
    const sw = COLORS.map(c => { const s = el("button", "swatch" + (c === color ? " on" : "")); s.style.background = c; s.title = c;
      s.onmousedown = e => e.preventDefault();
      s.onclick = () => { color = c; sw.forEach(x => x.classList.toggle("on", x === s)); if (sel) { sel.stroke = c; if (sel.fill !== "none") sel.fill = c + "55"; draw(); changed(); } }; return s; });
    tools.append(...sw);
    const fillBtn = iconBtn("format_color_fill", "Fill shapes", () => { fill = !fill; fillBtn.classList.toggle("on", fill); if (sel) { sel.fill = fill ? sel.stroke + "55" : "none"; draw(); changed(); } });
    tools.append(fillBtn, iconBtn("delete", "Delete selected shape", () => { if (sel) { b.shapes.splice(b.shapes.indexOf(sel), 1); sel = null; draw(); changed(); } }));
    const pt = e => { const r = svg.getBoundingClientRect(); return { x: (e.clientX - r.left) * 720 / r.width, y: (e.clientY - r.top) * b.h / r.height }; };
    function shapeNode(s) {
      const g = document.createElementNS(svgNS, "g"); g.classList.add("shape");
      const a = { stroke: s.stroke, "stroke-width": s.sw || 2.2, fill: s.fill || "none" };
      let nd;
      if (s.kind === "rect" || s.kind === "square") { nd = document.createElementNS(svgNS, "rect"); Object.assign(a, { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), width: Math.abs(s.w), height: Math.abs(s.h), rx: 8 }); }
      else if (s.kind === "circle" || s.kind === "ellipse") { nd = document.createElementNS(svgNS, "ellipse"); Object.assign(a, { cx: s.x + s.w / 2, cy: s.y + s.h / 2, rx: Math.abs(s.w / 2), ry: Math.abs(s.h / 2) }); }
      else if (s.kind === "triangle") { nd = document.createElementNS(svgNS, "polygon"); a.points = `${s.x + s.w / 2},${s.y} ${s.x + s.w},${s.y + s.h} ${s.x},${s.y + s.h}`; }
      else if (s.kind === "line" || s.kind === "arrow") { nd = document.createElementNS(svgNS, "line"); Object.assign(a, { x1: s.x, y1: s.y, x2: s.x + s.w, y2: s.y + s.h, "stroke-linecap": "round" }); }
      if (nd) { Object.entries(a).forEach(([k, v]) => nd.setAttribute(k, v)); g.append(nd); }
      if (s.kind === "arrow") {
        const ang = Math.atan2(s.h, s.w), L = 14, W = 6, ex = s.x + s.w, ey = s.y + s.h;
        const head = document.createElementNS(svgNS, "polygon");
        head.setAttribute("points", `${ex},${ey} ${ex - L * Math.cos(ang) + W * Math.sin(ang)},${ey - L * Math.sin(ang) - W * Math.cos(ang)} ${ex - L * Math.cos(ang) - W * Math.sin(ang)},${ey - L * Math.sin(ang) + W * Math.cos(ang)}`);
        head.setAttribute("fill", s.stroke); g.append(head);
      }
      if (s.text || s.kind === "text") {
        const t = document.createElementNS(svgNS, "text");
        t.setAttribute("x", s.x + s.w / 2); t.setAttribute("y", s.y + s.h / 2); t.setAttribute("text-anchor", "middle");
        t.setAttribute("dominant-baseline", "middle"); t.setAttribute("fill", s.stroke); t.setAttribute("font-family", "LM Roman");
        t.setAttribute("font-size", s.kind === "text" ? 22 : 17); t.textContent = s.text || "text"; g.append(t);
      }
      if (s.kind === "line" || s.kind === "arrow") { const hit = nd.cloneNode(); hit.setAttribute("stroke", "transparent"); hit.setAttribute("stroke-width", 14); g.append(hit); }
      g.onpointerdown = e => { if (tool !== "select") { tool = "select"; toolBtns.forEach(x => x.classList.toggle("on", x.title === "select")); }
        e.stopPropagation(); sel = s; draw(); drag(e, s, "move"); };
      g.ondblclick = e => { e.stopPropagation(); const v = prompt("Label for this shape:", s.text || ""); if (v !== null) { s.text = v; draw(); changed(); } };
      return g;
    }
    function draw() {
      svg.innerHTML = "";
      b.shapes.forEach(s => svg.append(shapeNode(s)));
      if (sel) {
        const x = Math.min(sel.x, sel.x + sel.w), y = Math.min(sel.y, sel.y + sel.h);
        const r = document.createElementNS(svgNS, "rect"); r.classList.add("sel-box");
        Object.entries({ x: x - 5, y: y - 5, width: Math.abs(sel.w) + 10, height: Math.abs(sel.h) + 10, rx: 6 }).forEach(([k, v]) => r.setAttribute(k, v));
        const h = document.createElementNS(svgNS, "circle"); h.classList.add("handle");
        h.setAttribute("cx", sel.x + sel.w); h.setAttribute("cy", sel.y + sel.h); h.setAttribute("r", 7);
        h.onpointerdown = e => { e.stopPropagation(); drag(e, sel, "resize"); };
        svg.append(r, h);
      }
    }
    function drag(e, s, mode) {
      const p0 = pt(e), o = { ...s };
      try { svg.setPointerCapture(e.pointerId); } catch (_) {}
      svg.onpointermove = ev => {
        const p = pt(ev), dx = p.x - p0.x, dy = p.y - p0.y;
        if (mode === "move") { s.x = o.x + dx; s.y = o.y + dy; }
        else { s.w = o.w + dx; s.h = o.h + dy; if (s.kind === "square" || s.kind === "circle") s.h = Math.sign(s.h || 1) * Math.abs(s.w); }
        draw();
      };
      svg.onpointerup = () => { svg.onpointermove = null; svg.onpointerup = null;
        if (mode === "resize" && Math.abs(s.w) < 4 && Math.abs(s.h) < 4) { b.shapes.splice(b.shapes.indexOf(s), 1); sel = null; }
        draw(); changed(); };
    }
    svg.onpointerdown = e => {
      if (tool === "select") { sel = null; draw(); return; }
      const p = pt(e);
      const s = { kind: tool, x: p.x, y: p.y, w: tool === "text" ? 120 : 1, h: tool === "text" ? 30 : 1, stroke: color,
        fill: fill && !["line", "arrow", "text"].includes(tool) ? color + "55" : "none", sw: 2.2 };
      if (tool === "text") { const v = prompt("Text:", ""); if (!v) return; s.text = v; s.x -= 60; s.y -= 15; b.shapes.push(s); sel = s; draw(); changed(); return; }
      b.shapes.push(s); sel = s; draw(); drag(e, s, "resize");
    };
    box.tabIndex = 0;
    box.onkeydown = e => { e.stopPropagation(); if ((e.key === "Delete" || e.key === "Backspace") && sel) { e.preventDefault(); b.shapes.splice(b.shapes.indexOf(sel), 1); sel = null; draw(); changed(); } };
    const rh = el("div", "resize-h"); rh.title = "Drag to change the height";
    rh.onpointerdown = e => {
      const y0 = e.clientY, h0 = b.h; rh.setPointerCapture(e.pointerId);
      rh.onpointermove = ev => { b.h = Math.max(120, Math.min(900, h0 + ev.clientY - y0)); svg.setAttribute("viewBox", `0 0 720 ${b.h}`); fit(); draw(); };
      rh.onpointerup = () => { rh.onpointermove = null; changed(); };
    };
    const fit = () => { const w = box.clientWidth || 720; svg.style.height = (b.h * w / 720) + "px"; };
    draw(); box.append(tools, svg, rh);
    new ResizeObserver(fit).observe(box);
    return box;
  }

  // ── quote + citation ──────────────────────────────────────────────────────
  function allRefs() { return [...docEl.querySelectorAll(".sb-island.sb-quote")].map(n => blocks.get(n.dataset.id)).filter(b => b?.ref); }
  function quoteView(b) {
    const box = el("div", "sb-quote");
    const t = el("textarea"); t.rows = 1; t.placeholder = "Quote, or your note about this source…"; t.value = b.text || "";
    t.oninput = () => { b.text = t.value; autosize(t); changed(); };
    t.onfocus = () => lastField = t;
    t.onkeydown = e => e.stopPropagation();
    box.append(t); setTimeout(() => autosize(t));
    const line = el("div", "sb-ref");
    if (b.ref) {
      const r = b.ref, a = r.authors || [];
      const who = a.slice(0, 3).join(", ") + (a.length > 3 ? " et al." : "");
      line.innerHTML = `<span class="n"></span><span>${esc(who)}${r.year ? ` (${esc(r.year)})` : ""}${who || r.year ? ". " : ""}<i>${esc(r.title)}</i>${r.venue ? `. ${esc(r.venue)}` : ""}${r.doi ? `. doi:${esc(r.doi)}` : ""}
        · <a href="${esc(r.url)}" target="_blank">open</a></span>`;
    } else {
      const add = el("button", "btn ghost"); add.innerHTML = `<span class="ms" style="font-size:18px;vertical-align:-4px">${glyph("link")}</span> add a source`;
      add.onclick = () => citeDialog(b); line.append(add);
    }
    box.append(line);
    return box;
  }
  function refreshRefs() {
    if (!docEl) return;
    const refs = allRefs();
    docEl.querySelectorAll(".sb-island.sb-quote").forEach(n => { const k = refs.indexOf(blocks.get(n.dataset.id)); const s = n.querySelector(".sb-ref .n"); if (s) s.textContent = k >= 0 ? `[${k + 1}]` : ""; });
    const box = root.querySelector(".sb-refs"); if (!box) return;
    box.innerHTML = refs.length ? `<h3>References</h3><ol>${refs.map(b => {
      const r = b.ref, a = r.authors || [];
      return `<li>${esc(a.slice(0, 3).join(", ") + (a.length > 3 ? " et al." : ""))}${r.year ? ` (${esc(r.year)})` : ""}. <i>${esc(r.title)}</i>.
        ${esc(r.venue || "")}${r.doi ? `. doi:${esc(r.doi)}` : ""}. <a href="${esc(r.url)}" target="_blank">${esc(r.url)}</a>${r.doi ? "" : ` (accessed ${esc(r.accessed || "")})`}</li>`;
    }).join("")}</ol>` : "";
  }
  function citeDialog(attachTo) {
    dialog(`<h3>Cite a link</h3><p>Paste a URL, a DOI (10.xxxx/…) or an arXiv id. Title, authors, year and journal are filled in from the page.</p>
      <input class="field" id="cite-url" placeholder="https://arxiv.org/abs/… or 10.1103/…" style="width:100%">
      <label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:14px"><input type="checkbox" id="cite-abs"> use the abstract as the quote</label>
      <div class="preview" id="cite-prev"></div>`,
      async () => {
        const url = $("#cite-url").value.trim(); if (!url) return false;
        $("#cite-prev").textContent = "Fetching…";
        try {
          const r = await api("GET", "cite?url=" + encodeURIComponent(url));
          const quoteText = $("#cite-abs").checked ? r.abstract : "";
          const ref = { title: r.title, authors: r.authors, year: r.year, venue: r.venue, doi: r.doi, url: r.url, accessed: r.accessed };
          if (attachTo) { attachTo.ref = ref; if (quoteText && !attachTo.text) attachTo.text = quoteText; rebuildIsland(attachTo); }
          else insertIsland(make.quote(quoteText, ref), false);
          toast("Reference added"); return true;
        } catch (e) { $("#cite-prev").textContent = "Could not read that link: " + e.message; return false; }
      }, "Add reference");
    setTimeout(() => $("#cite-url").focus(), 50);
  }
  function csvDialog(prefill = "") {
    dialog(`<h3>Import a table</h3><p>Paste cells from a spreadsheet, or CSV / TSV text. The first row becomes the header.</p>
      <textarea class="field" id="csv-text" rows="8" style="width:100%;font-family:var(--editor-font)" placeholder="name, value, unit&#10;h, 6.626e-34, J s"></textarea>
      <input type="file" id="csv-file" accept=".csv,.tsv,.txt" style="margin-top:10px">`,
      () => {
        const txt = $("#csv-text").value.trim(); if (!txt) return false;
        const first = txt.split("\n")[0];
        const sep = txt.includes("\t") ? "\t" : (first.includes(";") && !first.includes(",") ? ";" : ",");
        const rows = txt.split(/\r?\n/).filter(l => l.trim()).map(l => splitCSV(l, sep));
        insertIsland(make.table(rows), false);
        toast(`Table imported: ${rows.length} rows`); return true;
      }, "Import");
    $("#csv-text").value = prefill;
    $("#csv-file").onchange = async e => { const f = e.target.files[0]; if (f) $("#csv-text").value = await f.text(); };
  }
  function splitCSV(line, sep) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === sep && !q) { out.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    out.push(cur.trim()); return out;
  }

  // ── "/" on an empty line: block menu ──────────────────────────────────────
  const KINDS = [
    ["heading", "title", "Heading", "Section title"], ["math", "function", "Equation", "Display LaTeX, renders live"],
    ["table", "table", "Table", "Typed in place, booktabs style"], ["csv", "upload_file", "Import table", "Paste CSV / spreadsheet cells"],
    ["code", "code_blocks", "Code", "Syntax highlighted block"], ["sketch", "shapes", "Shapes", "Squares, circles, arrows…"],
    ["quote", "format_quote", "Quote", "With an optional reference"], ["cite", "link", "Cite a link", "URL / DOI / arXiv → reference"],
    ["image", "image", "Image", "Insert a picture"], ["divider", "horizontal_rule", "Divider", "A thin rule"],
  ];
  let menuOpen = false, menuSel = 0, menuItems = [], menuEl = null, menuPara = null;
  function slashCheck() {
    const t = currentTop();
    const txt = t && !isIsland(t) ? t.textContent : "";
    const m = txt.match(/^\/(\w*)$/);
    if (m) { menuPara = t; openMenu(t.getBoundingClientRect(), m[1].toLowerCase()); }
    else if (menuOpen) closeMenu();
  }
  function openMenu(rect, filter) {
    closeMenu();
    menuItems = KINDS.filter(k => !filter || k[2].toLowerCase().includes(filter) || k[0].includes(filter));
    if (!menuItems.length) return;
    menuSel = 0; menuOpen = true; menuEl = el("div", "slash-menu");
    menuItems.forEach((k, i) => {
      const bt = el("button", i === 0 ? "on" : ""); bt.innerHTML = `<span class="ms">${k[1]}</span><span>${k[2]}<span class="d">${k[3]}</span></span>`;
      bt.onmousedown = e => { e.preventDefault(); choose(i); }; menuEl.append(bt);
    });
    document.body.append(menuEl);
    menuEl.style.left = Math.min(rect.left, innerWidth - 280) + "px";
    menuEl.style.top = Math.min(rect.bottom + 6, innerHeight - menuEl.offsetHeight - 10) + "px";
  }
  function closeMenu() { menuEl?.remove(); menuEl = null; menuOpen = false; }
  function choose(i) {
    const k = menuItems[i]; closeMenu();
    if (menuPara && docEl.contains(menuPara)) { fillInline(menuPara, ""); caretTo(menuPara, "start"); }
    Scratch.add(k[0]);
  }
  function menuKey(e) {
    e.preventDefault();
    if (e.key === "Escape") return closeMenu();
    if (e.key === "Enter" || e.key === "Tab") return choose(menuSel);
    menuSel = (menuSel + (e.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
    [...menuEl.children].forEach((c, i) => c.classList.toggle("on", i === menuSel));
    menuEl.children[menuSel].scrollIntoView({ block: "nearest" });
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function autosize(t) { t.style.height = "0"; t.style.height = t.scrollHeight + "px"; }
  // Material Symbols codepoints: icon ligatures ("delete" → 🗑) do not work inside the
  // editable page (WebKit turns ligatures off there), codepoints always do
  const GLYPH = { arrow_upward: 0xe5d8, arrow_downward: 0xe5db, delete: 0xe872, add_row_below: 0xf422, add_column_right: 0xf424,
    delete_sweep: 0xe16c, view_column: 0xe8ec, title: 0xe264, format_strikethrough: 0xe246, content_copy: 0xe14d,
    arrow_selector_tool: 0xf82f, rectangle: 0xeb54, square: 0xeb36, circle: 0xef4a, radio_button_unchecked: 0xe836,
    change_history: 0xe86b, horizontal_rule: 0xf108, arrow_right_alt: 0xe941, format_color_fill: 0xe23a, link: 0xe157 };
  const glyph = name => GLYPH[name] ? String.fromCodePoint(GLYPH[name]) : name;
  function iconBtn(icon, ttl, fn) {
    const b = el("button", "icon-btn"); b.textContent = glyph(icon); b.title = ttl; b.contentEditable = "false";
    b.onmousedown = e => e.preventDefault();
    b.onclick = e => { e.stopPropagation(); fn(); }; return b;
  }
  function dialog(html, ok, okLabel = "OK") {
    const bg = $("#dialog-bg"); $("#dialog-body").innerHTML = html; $("#dialog-ok").textContent = okLabel; bg.classList.add("open");
    $("#dialog-ok").onclick = async () => { if (await ok()) bg.classList.remove("open"); };
    $("#dialog-cancel").onclick = () => bg.classList.remove("open");
  }

  // ── public API ────────────────────────────────────────────────────────────
  return {
    mount(container, data, cb) {
      root = container; onChange = cb; curPara = null; savedRange = null; lastField = null;
      build(data && data.blocks ? data : { title: data?.title || "", blocks: [] });
    },
    serialize() { return JSON.stringify(serialize(), null, 1); },
    title() { return title || "Untitled"; },
    focusEnd() { caretTo(docEl.lastElementChild, "end"); },
    add(kind) {
      if (kind === "cite") return citeDialog(null);
      if (kind === "csv") return csvDialog("");
      if (kind === "image") return this.pickImage();
      if (kind === "heading") {
        let t = currentTop() || docEl.lastElementChild;
        const h = headingEl(isIsland(t) ? "" : t.textContent.replace(/^\//, ""), 2);
        if (isIsland(t)) t.after(h); else t.replaceWith(h);
        ensureTrailingPara(); changed(); caretTo(h, "end"); return;
      }
      insertIsland(make[kind]());
    },
    pickImage() {
      const inp = $("#file-image");
      inp.onchange = async e => {
        const f = e.target.files[0]; e.target.value = ""; inp.onchange = null; if (!f) return;
        const r = await api("POST", "upload", undefined, { name: f.name, data: f });
        insertIsland(make.image(r.path), false);
      };
      inp.click();
    },
    // special characters go where you were last typing
    insertChar(ch) {
      const f = lastField;
      if (f && f !== docEl && document.contains(f)) {
        if (f.tagName === "TEXTAREA" || f.tagName === "INPUT") { f.focus(); f.setRangeText(ch, f.selectionStart, f.selectionEnd, "end"); f.dispatchEvent(new Event("input")); return true; }
        if (f.isContentEditable) { f.focus(); placeCaretEnd(f); document.execCommand("insertText", false, ch); return true; }
      }
      if (docEl && savedRange) {
        docEl.focus(); const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange);
        document.execCommand("insertText", false, ch); return true;
      }
      return false;
    },
    _doc: () => serialize(),
  };
})();
