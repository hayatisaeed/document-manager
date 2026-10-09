"""Normalise rich-text HTML so that each block element sits on its own line.

Editors such as TipTap emit HTML as one long line, which would make every git
diff a one-line "everything changed" diff. Putting one block per line gives
paragraph-level diffs and far fewer merge conflicts.
"""
import re

BLOCK_TAGS = (
    "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
    "pre", "table", "thead", "tbody", "tr", "figure", "figcaption", "div", "section", "hr",
)

_OPEN = re.compile(r"\s*(<(?:%s)(?:\s[^>]*)?/?>)" % "|".join(BLOCK_TAGS), re.IGNORECASE)
_CLOSE = re.compile(r"(</(?:%s)>)\s*" % "|".join(BLOCK_TAGS), re.IGNORECASE)
_PRE = re.compile(r"(<pre\b.*?</pre>)", re.IGNORECASE | re.DOTALL)


def format_html(html: str) -> str:
    html = html.replace("\r\n", "\n").strip()
    if not html:
        return ""
    # Do not touch whitespace inside <pre> blocks.
    chunks = []
    for i, part in enumerate(_PRE.split(html)):
        if i % 2 == 1:
            chunks.append(part)
            continue
        part = _OPEN.sub(r"\n\1", part)
        part = _CLOSE.sub(r"\1\n", part)
        lines = [line.strip() for line in part.split("\n")]
        cleaned = "\n".join(line for line in lines if line)
        if cleaned:
            chunks.append(cleaned)
    return "\n".join(chunks) + "\n"
