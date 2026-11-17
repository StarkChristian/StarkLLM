"""E-books (EPUB) and slide decks (PPTX): their text in reading order, by chapter and by slide (roadmap phase 2).

Read with the standard library only (zipfile and XML/HTML parsers), so the engine needs no new package. Both formats
are zip files that often come from strangers: the number of entries and the unpacked sizes are limited, copy-protected
(DRM) e-books are refused with a clear message, and text that is not shown (hidden elements of an e-book page, hidden
slides) is left out and counted, like on web pages (untrusted.py).
"""
import posixpath
import re
import zipfile
from html.parser import HTMLParser
from urllib.parse import unquote
from xml.etree import ElementTree as ET

from app.services import untrusted

MAX_ENTRIES = 10000
MAX_UNPACKED = 400 * 1024 * 1024     # all entries together
MAX_PART = 40 * 1024 * 1024          # one chapter or slide


class BookFormatError(ValueError):
    """A file that cannot be read; the message is shown to the user."""


def _open(path):
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise BookFormatError("The file is damaged or not a real e-book / presentation (it is not a valid zip file).")
    infos = z.infolist()
    if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_UNPACKED:
        z.close()
        raise BookFormatError("The file is too large when unpacked.")
    return z


def _read(z, name):
    try:
        info = z.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_PART:
        raise BookFormatError(f"A part of the file is too large ({name}).")
    return z.read(info)


def _xml(data):
    return ET.fromstring(data) if data else None


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _join(base_dir, href):
    href = unquote(href.split("#", 1)[0])
    return posixpath.normpath(posixpath.join(base_dir, href)) if href else ""


# ------------------------------------------------------------------------------------------------------------------ EPUB
class _PageText(HTMLParser):
    """Text of an e-book page (XHTML): paragraphs on their own lines, hidden elements left out and counted. A page
    can hold several chapters: it is split where the table of contents points into it (anchors: {element id: title})."""
    SKIP = {"script", "style", "head", "title"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "section", "pre"}
    VOID = {"br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr"}

    def __init__(self, anchors=None):
        super().__init__(convert_charrefs=True)
        self.anchors = anchors or {}
        self.used = set()                     # anchors found on the page
        self.sections = [[None, []]]          # [title from the table of contents or None, text parts]
        self.skip, self.hidden_depth, self.hidden = 0, 0, 0
        self.heading, self._in_heading = "", False

    @property
    def parts(self):
        return self.sections[-1][1]

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ("id", "name") and value in self.anchors:
                self.used.add(value)
                if "".join(self.parts).strip():
                    self.sections.append([self.anchors[value], []])
                else:
                    self.sections[-1][0] = self.anchors[value]
                break
        if tag in self.VOID:
            if tag == "br":
                self.parts.append("\n")
            return
        if tag in self.SKIP:
            self.skip += 1
        if self.hidden_depth:
            self.hidden_depth += 1
        elif untrusted.html_element_is_hidden(attrs):
            self.hidden_depth, self.hidden = 1, self.hidden + 1
        if tag in {"h1", "h2", "h3"} and not self.heading:
            self._in_heading = True

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        if self.hidden_depth:
            self.hidden_depth -= 1
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        if tag in {"h1", "h2", "h3"}:
            self._in_heading = False
        if tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.skip or self.hidden_depth:
            return
        self.parts.append(data)
        if self._in_heading:
            self.heading = (self.heading + " " + data).strip()

    def texts(self):
        """[(title or None, text)] of the chapters on this page."""
        out = []
        for title, parts in self.sections:
            lines = (" ".join(l.split()) for l in "".join(parts).split("\n"))
            out.append((title, "\n".join(l for l in lines if l)))
        return out


def _split(base_dir, href):
    """(part name in the zip, fragment) of a link."""
    href, _, fragment = href.partition("#")
    return _join(base_dir, href), unquote(fragment)


def _epub_toc(z, opf_dir, manifest, opf):
    """[(chapter file, fragment, title)] in the order of the EPUB 3 navigation page or the EPUB 2 toc.ncx."""
    entries = []
    nav = next((i for i in manifest.values() if "nav" in (i.get("properties") or "").split()), None)
    if nav:
        page = _read(z, _join(opf_dir, nav["href"]))
        if page:
            nav_dir = posixpath.dirname(_join(opf_dir, nav["href"]))
            # only the table of contents, not the landmarks or page list of the same page
            toc_part = re.search(rb'<nav\b[^>]*type="toc"[^>]*>(.*?)</nav>', page, re.S | re.I)
            for m in re.finditer(rb'<a\b[^>]*href="([^"]+)"[^>]*>(.*?)</a>', toc_part.group(1) if toc_part else page, re.S | re.I):
                title = " ".join(re.sub(r"<[^>]+>", " ", m.group(2).decode("utf-8", "replace")).split())
                entries.append((*_split(nav_dir, m.group(1).decode("utf-8", "replace")), title))
    if not entries:
        spine = opf.find("{*}spine")
        ncx_id = spine.get("toc") if spine is not None else None
        ncx = manifest.get(ncx_id) or next((i for i in manifest.values() if i.get("media-type") == "application/x-dtbncx+xml"), None)
        if ncx:
            root = _xml(_read(z, _join(opf_dir, ncx["href"])))
            ncx_dir = posixpath.dirname(_join(opf_dir, ncx["href"]))
            for point in (root.iter() if root is not None else []):
                if _local(point.tag) != "navPoint":
                    continue
                label = point.find("{*}navLabel/{*}text")
                content = point.find("{*}content")
                if label is not None and content is not None and label.text:
                    entries.append((*_split(ncx_dir, content.get("src", "")), " ".join(label.text.split())))
    seen, out = set(), []
    for file, fragment, title in entries:
        if title and (file, fragment) not in seen:
            seen.add((file, fragment))
            out.append((file, fragment, title))
    return out


def epub_chapters(path):
    """[{title, text, hidden}] in reading order (the spine). Raises BookFormatError for DRM or broken files."""
    z = _open(path)
    try:
        enc = _xml(_read(z, "META-INF/encryption.xml"))
        if enc is not None:
            # font obfuscation is allowed; anything else encrypted is DRM
            for ref in enc.iter():
                if _local(ref.tag) == "CipherReference" and not re.search(r"\.(otf|ttf|woff2?)$", ref.get("URI", ""), re.I):
                    raise BookFormatError("This e-book is copy-protected (DRM). StarkLLM can only read e-books without copy protection.")
        container = _xml(_read(z, "META-INF/container.xml"))
        rootfile = next((e.get("full-path") for e in (container.iter() if container is not None else []) if _local(e.tag) == "rootfile"), None)
        opf_data = _read(z, rootfile) if rootfile else None
        if not opf_data:
            raise BookFormatError("The e-book has no table of contents file (OPF); it may be damaged.")
        opf, opf_dir = _xml(opf_data), posixpath.dirname(rootfile)
        manifest = {i.get("id"): {"href": i.get("href", ""), "media-type": i.get("media-type", ""), "properties": i.get("properties", "")}
                    for i in opf.iter() if _local(i.tag) == "item"}
        toc = _epub_toc(z, opf_dir, manifest, opf)
        # last_title: the chapter title from the table of contents that a following file without one continues
        # (long chapters are often split into several files); a file without any title becomes "Part n"
        chapters, last_title = [], ""
        for ref in opf.iter():
            if _local(ref.tag) != "itemref":
                continue
            item = manifest.get(ref.get("idref"))
            if not item or "html" not in item["media-type"]:
                continue
            name = _join(opf_dir, item["href"])
            data = _read(z, name)
            if not data:
                continue
            page = _PageText({frag: title for file, frag, title in toc if file == name and frag})
            page.feed(data.decode("utf-8", "replace"))
            # the title of the file itself: a table-of-contents entry for it whose anchor is not on the page (or has none)
            file_title = next((title for file, frag, title in toc if file == name and (not frag or frag not in page.used)), None)
            hidden = page.hidden
            for i, (title, text) in enumerate(page.texts()):
                if not text and not hidden:
                    continue
                if not title and i == 0:
                    title = file_title
                if title:
                    last_title = title
                else:
                    title = last_title or page.heading[:80] or f"Part {len(chapters) + 1}"
                chapters.append({"title": title, "text": text, "hidden": hidden})
                hidden = 0
        if not any(c["text"] for c in chapters):
            raise BookFormatError("No text was found in the e-book.")
        return chapters
    except ET.ParseError as e:
        raise BookFormatError(f"The e-book could not be read ({e}).")
    finally:
        z.close()


# ------------------------------------------------------------------------------------------------------------------ PPTX
REL_SLIDE = "/relationships/slide"
REL_NOTES = "/relationships/notesSlide"


def _rels(z, part):
    """{relationship id: (type, target part)} of a part."""
    folder, name = posixpath.split(part)
    root = _xml(_read(z, posixpath.join(folder, "_rels", name + ".rels")))
    out = {}
    for r in (root if root is not None else []):
        out[r.get("Id")] = (r.get("Type", ""), _join(folder, r.get("Target", "")))
    return out


def _shape_paragraphs(root):
    """(is title, [paragraph texts]) for every text shape of a slide or notes page."""
    shapes = []
    for sp in root.iter():
        if _local(sp.tag) != "sp":
            continue
        ph = next((e for e in sp.iter() if _local(e.tag) == "ph"), None)
        kind = ph.get("type", "") if ph is not None else ""
        paras = []
        for p in sp.iter():
            if _local(p.tag) == "p":
                t = "".join(e.text or "" for e in p.iter() if _local(e.tag) == "t").strip()
                if t:
                    paras.append(t)
        shapes.append((kind, paras))
    return shapes


def pptx_slides(path):
    """[{number, title, text, hidden}] in the order of the presentation; hidden slides have no text, only hidden=True."""
    z = _open(path)
    try:
        pres = _xml(_read(z, "ppt/presentation.xml"))
        if pres is None:
            raise BookFormatError("The presentation has no slide list; it may be damaged or not a PowerPoint file.")
        rels = _rels(z, "ppt/presentation.xml")
        order = [rels[s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")][1]
                 for s in pres.iter() if _local(s.tag) == "sldId"
                 and s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id") in rels]
        slides = []
        for number, part in enumerate(order, 1):
            root = _xml(_read(z, part))
            if root is None:
                continue
            if root.get("show") == "0":
                slides.append({"number": number, "title": "", "text": "", "hidden": True})
                continue
            title, body = "", []
            for kind, paras in _shape_paragraphs(root):
                if kind in ("title", "ctrTitle") and not title:
                    title = " ".join(paras)
                elif kind not in ("sldNum", "dt", "ftr"):
                    body.extend(paras)
            notes_part = next((target for kind, target in _rels(z, part).values() if kind.endswith(REL_NOTES)), None)
            notes = []
            if notes_part:
                notes_root = _xml(_read(z, notes_part))
                for kind, paras in (_shape_paragraphs(notes_root) if notes_root is not None else []):
                    if kind not in ("sldImg", "sldNum", "dt", "ftr", "hdr"):
                        notes.extend(paras)
            text = "\n".join(body) + (("\nSpeaker notes: " + " ".join(notes)) if notes else "")
            slides.append({"number": number, "title": title, "text": text.strip(), "hidden": False})
        if not any(s["title"] or s["text"] for s in slides):
            raise BookFormatError("No text was found in the presentation.")
        return slides
    except ET.ParseError as e:
        raise BookFormatError(f"The presentation could not be read ({e}).")
    finally:
        z.close()
