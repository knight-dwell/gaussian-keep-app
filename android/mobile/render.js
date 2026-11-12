// render.js: what pandoc does on the laptop, done on the phone.
//   math:   LaTeX → MathML with temml (the Pixel's WebView renders MathML natively)
//   md:     a compact Markdown renderer (headings, lists, quotes, tables, code, $math$)
//   code:   a small highlighter using pandoc's token classes, so it looks the same as on the laptop
//   cite:   fetch a page natively (Android bridge) and read its citation <meta> tags
"use strict";

const Render = (() => {
  const escH = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function math(tex, display) {
    try { return temml.renderToString(tex, { displayMode: !!display, throwOnError: false, annotate: false }); }
    catch (e) { return `<code>${escH(tex)}</code>`; }
  }

  // inline Markdown: $math$, **bold**, *italic*, `code`, [text](url), <url>
  function inline(s) {
    const out = []; let i = 0;
    const tok = /(\$[^$\n]+?\$)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(`[^`\n]+?`)|(\[[^\]\n]+\]\([^)\s]+\))|(<https?:\/\/[^>\s]+>)/g;
    for (const m of s.matchAll(tok)) {
      out.push(escH(s.slice(i, m.index)));
      const t = m[0];
      if (m[1]) out.push(math(t.slice(1, -1), false));
      else if (m[2]) out.push(`<strong>${inline(t.slice(2, -2))}</strong>`);
      else if (m[3]) out.push(`<em>${inline(t.slice(1, -1))}</em>`);
      else if (m[4]) out.push(`<code>${escH(t.slice(1, -1))}</code>`);
      else if (m[5]) { const mm = t.match(/^\[([^\]]+)\]\(([^)]+)\)$/); out.push(`<a href="${escH(mm[2])}">${inline(mm[1])}</a>`); }
      else { const u = t.slice(1, -1); out.push(`<a href="${escH(u)}">${escH(u)}</a>`); }
      i = m.index + t.length;
    }
    out.push(escH(s.slice(i)));
    return out.join("");
  }

  // block Markdown
  function md(src) {
    const lines = src.replace(/\r/g, "").split("\n"); const html = []; let i = 0;
    const isTableSep = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
    const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) { i++; continue; }
      let m;
      if ((m = l.match(/^```\s*([\w+#-]*)/))) {                       // code fence
        const body = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
        i++; html.push(code(body.join("\n"), m[1])); continue;
      }
      if (/^\s*\$\$/.test(l)) {                                        // display math
        let t = l.replace(/^\s*\$\$/, "");
        if (/\$\$\s*$/.test(t)) { html.push(`<p>${math(t.replace(/\$\$\s*$/, ""), true)}</p>`); i++; continue; }
        const body = [t]; i++;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
        if (i < lines.length) body.push(lines[i++].replace(/\$\$\s*$/, ""));
        html.push(`<p>${math(body.join("\n"), true)}</p>`); continue;
      }
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { html.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) { html.push("<hr>"); i++; continue; }
      if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {   // pipe table
        const head = cells(l); i += 2; const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
        html.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
          rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`); continue;
      }
      if (/^>\s?/.test(l)) {
        const body = []; while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
        html.push(`<blockquote>${md(body.join("\n"))}</blockquote>`); continue;
      }
      if ((m = l.match(/^(\s*)([-*+]|\d+\.)\s+/))) {                    // lists
        const ordered = /\d/.test(m[2]); const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          let it = lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, "");
          const box = it.match(/^\[([ xX])\]\s+/);
          if (box) it = `<input type="checkbox" disabled ${box[1] !== " " ? "checked" : ""}> ` + inline(it.slice(box[0].length)); else it = inline(it);
          items.push(`<li>${it}</li>`);
        }
        html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`); continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>\s?|\s*\$\$|\s*([-*+]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      html.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    return html.join("\n");
  }

  // ── code highlighting with pandoc/skylighting class names ─────────────────
  const KW = {
    python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False",
    julia: "abstract begin break catch const continue do else elseif end export false finally for function global if import let local macro module mutable quote return struct true try using while",
    c: "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while",
    js: "async await break case catch class const continue default delete do else export extends false finally for function if import in instanceof let new null of return super switch this throw true try typeof undefined var void while yield",
    rust: "as async await break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
    bash: "if then else elif fi for in do done while until case esac function return local export echo exit",
    fortran: "program end subroutine function module use implicit none integer real double precision complex logical character do if then else call return contains allocate deallocate intent in out inout",
    go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil",
  };
  const alias = { cpp: "c", java: "js", javascript: "js", typescript: "js", zsh: "bash", sh: "bash", matlab: "python", r: "python", lua: "js" };
  function code(src, lang) {
    const l = (lang || "").toLowerCase(); const kw = new Set((KW[l] || KW[alias[l]] || "").split(" ").filter(Boolean));
    const hashC = /^(python|julia|bash|zsh|sh|r|yaml|toml|makefile|dockerfile)$/.test(l), slashC = /^(c|cpp|js|javascript|typescript|java|rust|go|css)$/.test(l);
    const pctC = /^(latex|matlab|tex)$/.test(l);
    const tokenRx = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(#.*$|\/\/.*$|%.*$|--.*$)|(\b\d+(?:\.\d+)?(?:[eE][-+]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)(\s*\()?|([-+*/=<>!&|^%~]+)/gm;
    const lines = src.split("\n").map((line, n) => {
      let out = "", i = 0;
      for (const m of line.matchAll(tokenRx)) {
        out += escH(line.slice(i, m.index)); const t = m[0];
        if (m[1]) out += `<span class="st">${escH(t)}</span>`;
        else if (m[2]) {
          const c = m[2]; const isComment = (c.startsWith("#") && hashC) || (c.startsWith("//") && slashC) || (c.startsWith("%") && pctC) || (c.startsWith("--") && l === "lua");
          if (isComment) { out += `<span class="co">${escH(line.slice(m.index))}</span>`; i = line.length; break; }
          out += escH(t);
        }
        else if (m[3]) out += `<span class="dv">${t}</span>`;
        else if (m[4]) out += kw.has(m[4]) ? `<span class="kw">${m[4]}</span>${escH(m[5] || "")}` : m[5] ? `<span class="fu">${m[4]}</span>${escH(m[5])}` : escH(m[4]);
        else if (m[6]) out += `<span class="op">${escH(t)}</span>`;
        i = m.index + t.length;
      }
      if (i < line.length) out += escH(line.slice(i));
      return `<span id="l${n + 1}"><a></a>${out}</span>`;
    });
    return `<div class="sourceCode"><pre class="sourceCode numberSource ${escH(l)} numberLines"><code>${lines.join("\n")}</code></pre></div>`;
  }

  // ── citations ────────────────────────────────────────────────────────────
  function cite(url) {
    url = url.trim();
    if (/^10\.\d{4,9}\/\S+$/.test(url)) url = "https://doi.org/" + url;
    const ax = url.match(/^(?:arxiv:)?(\d{4}\.\d{4,5})(v\d+)?$/i); if (ax) url = "https://arxiv.org/abs/" + ax[1];
    const found = url.match(/https?:\/\/\S+/); if (found) url = found[0];
    if (!/^https?:\/\//.test(url)) throw new Error("Give a link, DOI or arXiv id");
    const r = JSON.parse(Android.fetchUrl(url));
    if (!r.status || r.status >= 400) throw new Error(r.error || "HTTP " + r.status);
    const doc = new DOMParser().parseFromString(r.body, "text/html");
    const meta = {};
    doc.querySelectorAll("meta[name], meta[property]").forEach(m => {
      const k = (m.getAttribute("name") || m.getAttribute("property")).toLowerCase(); const v = (m.getAttribute("content") || "").trim();
      if (v) (meta[k] ||= []).push(v);
    });
    const first = (...ks) => { for (const k of ks) if (meta[k]?.length) return meta[k][0]; return ""; };
    const date = first("citation_publication_date", "citation_date", "citation_online_date", "dc.date", "article:published_time", "date");
    let doi = first("citation_doi", "dc.identifier"); if (/^doi:/i.test(doi)) doi = doi.slice(4);
    return {
      title: first("citation_title", "dc.title", "og:title", "twitter:title") || (doc.title || "").trim(),
      authors: (meta["citation_author"] || meta["dc.creator"] || meta["author"] || meta["article:author"] || []).slice(0, 12),
      year: (date.match(/(19|20)\d{2}/) || [""])[0],
      venue: first("citation_journal_title", "citation_conference_title", "citation_publisher", "og:site_name") || new URL(r.url).hostname,
      doi, url: r.url, abstract: first("citation_abstract", "description", "og:description", "dc.description").slice(0, 600),
      accessed: new Date().toISOString().slice(0, 10),
    };
  }

  return { math, inline, md, code, cite, escH };
})();
