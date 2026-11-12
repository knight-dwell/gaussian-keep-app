"""Scratchbook support for gaussian_keep.

A scratchbook note (notes/<id>.keep) is JSON: {"title": str, "blocks": [...]}.
Block types: text, heading, math, table, code, sketch, quote, image, divider.

  render(items)       many snippets → HTML in ONE pandoc call (Markdown + LaTeX
                      math as MathML, code highlighted by pandoc/skylighting)
  cite(url)           fetch a web page and pull citation data from its <meta> tags
                      (citation_*, Dublin Core, OpenGraph), e.g. arXiv, journals, blogs
  to_markdown(doc)    the note as Markdown (sketches become PNGs) for export / PDF
"""
import datetime as dt
import html
import ipaddress
import json
import os
import re
import socket
import subprocess
import urllib.parse
import urllib.request
from html.parser import HTMLParser

SPLIT = "KEEPSPLIT9f3"


def _pandoc(md, extra=()):
    r = subprocess.run(["pandoc", "-f", "markdown+tex_math_dollars+pipe_tables+raw_html", "-t", "html5",
                        "--mathml", *extra],
                       input=md, capture_output=True, text=True, timeout=60)
    return r.stdout


def render(items):
    """items: [{"kind": "md"|"inline"|"math"|"code", "text": str, "lang": str}] → [html]"""
    parts = []
    for it in items:
        text = it.get("text", "")
        kind = it.get("kind", "md")
        if kind == "math":
            parts.append("$$\n" + text.strip() + "\n$$" if text.strip() else "")
        elif kind == "code":
            lang = re.sub(r"[^a-z0-9+#-]", "", (it.get("lang") or "").lower())
            fence = "````" if "```" in text else "```"
            parts.append(f"{fence}{{.{lang or 'default'} .numberLines}}\n{text}\n{fence}")
        else:
            parts.append(text)
    doc = f"\n\n<!--{SPLIT}-->\n\n".join(parts)
    out = _pandoc(doc)
    chunks = re.split(rf"<!--{SPLIT}-->", out)
    chunks += [""] * (len(items) - len(chunks))
    res = []
    for it, h in zip(items, chunks):
        h = h.strip()
        if it.get("kind") == "inline":   # table cells: no wrapping <p>
            h = re.sub(r"^<p>(.*)</p>$", r"\1", h, flags=re.S)
        res.append(h)
    return res


# ── citations ────────────────────────────────────────────────────────────────
class _Meta(HTMLParser):
    def __init__(self):
        super().__init__()
        self.meta, self.title, self._in_title = {}, "", False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "meta":
            key = (a.get("name") or a.get("property") or "").lower()
            if key and a.get("content"):
                self.meta.setdefault(key, []).append(a["content"].strip())
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def _public_host(host):
    """Refuse URLs that point into this machine or the local network."""
    try:
        for info in socket.getaddrinfo(host, None):
            ip = ipaddress.ip_address(info[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast:
                return False
        return True
    except (socket.gaierror, ValueError):
        return False


def cite(url):
    url = url.strip()
    if re.match(r"^10\.\d{4,9}/\S+$", url):            # a bare DOI
        url = "https://doi.org/" + url
    m = re.match(r"^(?:arxiv:)?(\d{4}\.\d{4,5})(v\d+)?$", url, re.I)
    if m:                                              # a bare arXiv id
        url = "https://arxiv.org/abs/" + m.group(1)
    u = urllib.parse.urlparse(url)
    if u.scheme not in ("http", "https") or not u.hostname or not _public_host(u.hostname):
        raise ValueError("Give a public http(s) link, DOI or arXiv id")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux) gaussian_keep/1.0",
                                               "Accept": "text/html,application/xhtml+xml"})
    with urllib.request.urlopen(req, timeout=12) as r:
        final = r.geturl()
        raw = r.read(3_000_000)
        charset = r.headers.get_content_charset() or "utf-8"
    p = _Meta()
    p.feed(raw.decode(charset, errors="replace"))
    m = p.meta
    first = lambda *keys: next((m[k][0] for k in keys if m.get(k)), "")
    authors = m.get("citation_author") or m.get("dc.creator") or m.get("author") or m.get("article:author") or []
    date = first("citation_publication_date", "citation_date", "citation_online_date", "dc.date",
                 "article:published_time", "date")
    year = (re.search(r"(19|20)\d{2}", date) or [None])[0] if date else ""
    ref = {
        "title": html.unescape(first("citation_title", "dc.title", "og:title", "twitter:title") or p.title.strip()),
        "authors": [html.unescape(a) for a in authors][:12],
        "year": year or "",
        "venue": html.unescape(first("citation_journal_title", "citation_conference_title", "citation_publisher",
                                     "og:site_name") or (urllib.parse.urlparse(final).hostname or "")),
        "doi": first("citation_doi", "dc.identifier"),
        "url": final,
        "abstract": html.unescape(first("citation_abstract", "description", "og:description", "dc.description"))[:600],
        "accessed": dt.date.today().isoformat(),
    }
    if ref["doi"].lower().startswith("doi:"):
        ref["doi"] = ref["doi"][4:]
    return ref


def format_ref(r):
    a = r.get("authors") or []
    names = ", ".join(a[:3]) + (" et al." if len(a) > 3 else "")
    bits = [names + (f" ({r['year']})" if r.get("year") else ""), f"*{r.get('title', '')}*", r.get("venue", "")]
    s = ". ".join(b for b in bits if b.strip())
    if r.get("doi"):
        s += f". doi:{r['doi']}"
    elif r.get("url"):
        s += f". <{r['url']}> (accessed {r.get('accessed', '')})"
    return s


# ── export ───────────────────────────────────────────────────────────────────
def _ink(color):
    """Light colors (meant for the dark editor) become dark ink on white paper."""
    m = re.match(r"^#([0-9a-fA-F]{6})", color or "")
    if not m:
        return color
    r, g, b = (int(m.group(1)[i:i + 2], 16) for i in (0, 2, 4))
    return "#2b2f36" if (0.299 * r + 0.587 * g + 0.114 * b) > 200 else color


def _svg(block):
    w, h = 720, int(block.get("h", 260))
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">']
    for s in block.get("shapes", []):
        s = dict(s, stroke=_ink(s.get("stroke", "#333")))
        st = f'stroke="{html.escape(s.get("stroke", "#333"))}" stroke-width="{s.get("sw", 2)}" fill="{html.escape(s.get("fill", "none"))}"'
        x, y, ww, hh = (float(s.get(k, 0)) for k in ("x", "y", "w", "h"))
        k = s.get("kind")
        if k == "rect":
            out.append(f'<rect x="{x}" y="{y}" width="{ww}" height="{hh}" rx="{s.get("r", 6)}" {st}/>')
        elif k in ("ellipse", "circle"):
            out.append(f'<ellipse cx="{x + ww / 2}" cy="{y + hh / 2}" rx="{ww / 2}" ry="{hh / 2}" {st}/>')
        elif k == "triangle":
            out.append(f'<polygon points="{x + ww / 2},{y} {x + ww},{y + hh} {x},{y + hh}" {st}/>')
        elif k in ("line", "arrow"):
            out.append(f'<line x1="{x}" y1="{y}" x2="{x + ww}" y2="{y + hh}" {st} stroke-linecap="round"/>')
            if k == "arrow":   # arrowhead in the arrow's color
                import math
                a, L, W, ex, ey = math.atan2(hh, ww), 14, 6, x + ww, y + hh
                p1 = (ex - L * math.cos(a) + W * math.sin(a), ey - L * math.sin(a) - W * math.cos(a))
                p2 = (ex - L * math.cos(a) - W * math.sin(a), ey - L * math.sin(a) + W * math.cos(a))
                out.append(f'<polygon points="{ex},{ey} {p1[0]},{p1[1]} {p2[0]},{p2[1]}" fill="{html.escape(s.get("stroke", "#333"))}"/>')
        if s.get("text"):
            out.append(f'<text x="{x + ww / 2}" y="{y + hh / 2}" text-anchor="middle" dominant-baseline="middle" '
                       f'font-family="serif" font-size="16" fill="{html.escape(s.get("stroke", "#333"))}">{html.escape(s["text"])}</text>')
    out.append("</svg>")
    return "\n".join(out)


def to_markdown(doc, nid, build_dir):
    lines, refs = [f"# {doc.get('title', 'Untitled')}", ""], []
    for i, b in enumerate(doc.get("blocks", [])):
        t = b.get("type")
        if t == "text":
            lines.append(b.get("md", ""))
        elif t == "heading":
            lines.append("#" * min(max(int(b.get("level", 2)), 1), 4) + " " + b.get("text", ""))
        elif t == "math":
            lines.append("$$\n" + b.get("tex", "") + "\n$$")
        elif t == "table":
            rows = b.get("rows") or [[""]]
            ncol = max(len(r) for r in rows)
            rows = [r + [""] * (ncol - len(r)) for r in rows]
            cell = lambda c: c.replace("|", "\\|").replace("\n", " ")
            lines.append("| " + " | ".join(cell(c) for c in rows[0]) + " |")
            lines.append("|" + "---|" * ncol)
            lines += ["| " + " | ".join(cell(c) for c in r) + " |" for r in rows[1:]]
            if b.get("caption"):
                lines.append(f"\n: {b['caption']}")
        elif t == "code":
            lines.append(f"```{b.get('lang') or ''}\n{b.get('code', '')}\n```")
        elif t == "sketch":
            os.makedirs(build_dir, exist_ok=True)
            svg = os.path.join(build_dir, f"{nid}-sketch{i}.svg")
            png = svg[:-4] + ".png"
            with open(svg, "w") as fh:
                fh.write(_svg(b))
            subprocess.run(["rsvg-convert", "-w", "1440", svg, "-o", png], capture_output=True)
            lines.append(f"![]({png})")
        elif t == "quote":
            q = b.get("text", "").strip()
            if q:
                lines += ["> " + l for l in q.splitlines()]
            if b.get("ref"):
                refs.append(b["ref"])
                lines.append(f"> — [{len(refs)}]")
        elif t == "image":
            lines.append(f"![{b.get('caption', '')}]({b.get('path', '')})")
        elif t == "divider":
            lines.append("---")
        lines.append("")
    if refs:
        lines += ["## References", ""] + [f"{n}. {format_ref(r)}" for n, r in enumerate(refs, 1)]
    return "\n".join(lines) + "\n"
