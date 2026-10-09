/**
 * Obsidian-style live preview for Markdown in CodeMirror: the file text stays
 * exactly as written, but syntax (##, **, [](…), $…$) is hidden and the result is
 * shown formatted — math through KaTeX, images, tables, callouts, task boxes,
 * citations and footnotes. Wherever the cursor or selection is, the raw source
 * comes back so it can be edited.
 */
import { syntaxTree } from "@codemirror/language";
import { RangeSet, StateField, type EditorState, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, gutterLineClass, WidgetType, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import katex from "katex";
import { CALLOUT_KINDS, renderMarkdown } from "../components/notebookRender";

// ------------------------------------------------------------------ widgets

/** A rendered element; clicking it puts the cursor there, which reveals its source. */
abstract class Rendered extends WidgetType {
  ignoreEvent() {
    return false;
  }
}

class MathWidget extends Rendered {
  constructor(readonly tex: string, readonly display: boolean, readonly preview = false) {
    super();
  }
  eq(other: MathWidget) {
    return other.tex === this.tex && other.display === this.display && other.preview === this.preview;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.display ? `cm-lp-math-block ${this.preview ? "cm-lp-math-preview" : ""}` : "cm-lp-math";
    el.innerHTML = katex.renderToString(this.tex, { displayMode: this.display, throwOnError: false });
    return el;
  }
}

class ImageWidget extends Rendered {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "cm-lp-image";
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt;
    return img;
  }
}

class TableWidget extends Rendered {
  constructor(readonly source: string) {
    super();
  }
  eq(other: TableWidget) {
    return other.source === this.source;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-lp-table";
    el.innerHTML = renderMarkdown(this.source);
    // A click on a link inside the table should edit the table, not follow the link.
    el.addEventListener("click", (e) => e.preventDefault());
    return el;
  }
}

class TextWidget extends Rendered {
  constructor(readonly text: string, readonly cls: string) {
    super();
  }
  eq(other: TextWidget) {
    return other.text === this.text && other.cls === this.cls;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // Flip the [ ] / [x] that follows the list mark this widget stands for.
      const pos = view.posAtDOM(box);
      const line = view.state.doc.lineAt(pos);
      const m = /\[[ xX]\]/.exec(line.text.slice(pos - line.from));
      if (!m) return;
      const at = pos + m.index + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

// ------------------------------------------------------------------ decorations

const hidden = Decoration.replace({});
const markCache = new Map<string, Decoration>();
const lineCache = new Map<string, Decoration>();
const mark = (cls: string) => markCache.get(cls) ?? markCache.set(cls, Decoration.mark({ class: cls })).get(cls)!;
const lineDeco = (cls: string) => lineCache.get(cls) ?? lineCache.set(cls, Decoration.line({ class: cls })).get(cls)!;

/**
 * The line-number element of a styled line gets the same classes, renamed
 * cm-lp-… → cm-lp-g-…, so CSS can give it the line's padding and line height
 * and the number stays level with the text.
 */
class LineClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}
const gutterCache = new Map<string, LineClassMarker>();
const gutterMarker = (cls: string) =>
  gutterCache.get(cls) ?? gutterCache.set(cls, new LineClassMarker(cls.replace(/\bcm-lp-/g, "cm-lp-g-"))).get(cls)!;

interface Preview {
  decorations: DecorationSet;
  gutter: RangeSet<GutterMarker>;
}

const HEADING = /^ATXHeading(\d)$/;
const CALLOUT_RE = /^(\s*>\s?)\[!(\w+)\][-+]?[ \t]*/;
// Pandoc citations: [@key], [see @key, p. 3; -@other], and @key in running text.
const CITATION = /\[(?:[^[\]\n]*[\s;-])?-?@[^[\]\n]+\](?!\()|(?<![\w@\]\\])@[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&+?<>~/-]*[\p{L}\p{N}_])?/gu;
// [[target#heading|alias]], as indexed by the backend (core/services/links.py).
const WIKI_LINK = /\[\[([^\]|#\n]+)(#[^\]|\n]*)?(\|[^\]\n]*)?\]\]/g;
const FOOTNOTE_REF = /\[\^([^\]\s]+)\](?!:)/g;
const FOOTNOTE_DEF = /^\[\^[^\]\s]+\]:/;
/** Nodes in which citation/footnote-looking text is literal. */
const LITERAL = new Set(["InlineCode", "InlineMath", "URL", "Image", "Autolink", "HTMLTag", "Comment"]);

function children(node: SyntaxNode, name: string): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) out.push(c);
  return out;
}

function build(state: EditorState, resolveSrc: (src: string) => string): Preview {
  const { doc } = state;
  const tree = syntaxTree(state);
  const ranges: Range<Decoration>[] = [];
  const replaced: Range<Decoration>[] = [];
  const gutter: Range<GutterMarker>[] = [];
  const sel = state.selection.ranges;

  /** Does the cursor or selection touch [from, to]? Edges count, so arrowing into an element reveals it. */
  const touches = (from: number, to: number) => sel.some((r) => r.from <= to && r.to >= from);
  /** Is the cursor on any of the lines of [from, to]? */
  const onLines = (from: number, to: number) => touches(doc.lineAt(from).from, doc.lineAt(to).to);
  const replace = (from: number, to: number, widget?: WidgetType) => {
    if (to > from || widget) replaced.push((widget ? Decoration.replace({ widget }) : hidden).range(from, to));
  };
  const lines = (from: number, to: number, cls: (n: number, first: number, last: number) => string) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) {
      const c = cls(n, first, last);
      const at = doc.line(n).from;
      ranges.push(lineDeco(c).range(at));
      gutter.push(gutterMarker(c).range(at));
    }
  };
  /** Hide a mark plus the single space after it (e.g. "## " or "> "). */
  const hideWithSpace = (m: SyntaxNode) => replace(m.from, doc.sliceString(m.to, m.to + 1) === " " ? m.to + 1 : m.to);
  const literalAt = (pos: number) => {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) if (LITERAL.has(n.name)) return true;
    return false;
  };

  tree.iterate({
    enter(ref) {
      const node = ref.node;
      const { name, from, to } = node;
      const heading = HEADING.exec(name);
      if (heading) {
        lines(from, from, () => `cm-lp-h cm-lp-h${heading[1]}`);
        if (!onLines(from, to)) for (const m of children(node, "HeaderMark")) m.from === from ? hideWithSpace(m) : replace(m.from, m.to);
        return;
      }
      switch (name) {
        case "SetextHeading1":
        case "SetextHeading2": {
          const underline = children(node, "HeaderMark")[0];
          const textEnd = underline ? doc.lineAt(underline.from).from - 1 : to;
          lines(from, Math.max(from, textEnd), () => `cm-lp-h cm-lp-h${name.slice(-1)}`);
          if (underline && !onLines(from, to)) replace(underline.from, underline.to);
          return;
        }
        case "Emphasis":
        case "StrongEmphasis":
        case "Strikethrough": {
          ranges.push(mark(name === "Emphasis" ? "cm-lp-em" : name === "StrongEmphasis" ? "cm-lp-strong" : "cm-lp-strike").range(from, to));
          if (!touches(from, to)) for (const m of [...children(node, "EmphasisMark"), ...children(node, "StrikethroughMark")]) replace(m.from, m.to);
          return;
        }
        case "InlineCode": {
          ranges.push(mark("cm-lp-code").range(from, to));
          if (!touches(from, to)) for (const m of children(node, "CodeMark")) replace(m.from, m.to);
          return false;
        }
        case "Link": {
          const marks = children(node, "LinkMark");
          const hasTarget = node.getChild("URL") || node.getChild("LinkLabel");
          if (hasTarget && marks.length >= 2 && !touches(from, to)) {
            replace(marks[0].from, marks[0].to);
            replace(marks[1].from, to);
            ranges.push(mark("cm-lp-link").range(marks[0].to, marks[1].from));
          }
          return;
        }
        case "Image": {
          const marks = children(node, "LinkMark");
          const url = node.getChild("URL");
          if (url && marks.length >= 2 && !touches(from, to)) {
            const src = doc.sliceString(url.from, url.to).replace(/^<|>$/g, "");
            replace(from, to, new ImageWidget(resolveSrc(src), doc.sliceString(marks[0].to, marks[1].from)));
          }
          return false;
        }
        case "Blockquote": {
          const first = doc.lineAt(from);
          const callout = CALLOUT_RE.exec(doc.sliceString(from, first.to));
          if (!callout) {
            lines(from, to, () => "cm-lp-quote");
            return;
          }
          const kind = CALLOUT_KINDS[callout[2].toLowerCase()] ?? "note";
          lines(from, to, (n, a, b) =>
            `cm-lp-callout callout-${kind}${n === a ? " cm-lp-callout-title" : ""}${n === b ? " cm-lp-callout-last" : ""}`,
          );
          if (!onLines(from, from)) {
            // "> [!warning] Title" shows as the title alone; without a title, as the callout kind.
            const end = from + callout[0].length;
            const label = end >= first.to ? callout[2][0].toUpperCase() + callout[2].slice(1).toLowerCase() : "";
            replace(from, end, label ? new TextWidget(label, "cm-lp-callout-label") : undefined);
          }
          return;
        }
        case "QuoteMark":
          if (!onLines(from, to)) hideWithSpace(node);
          return;
        case "ListMark": {
          const item = node.parent;
          if (item?.parent?.name !== "BulletList" || item.getChild("Task")) return;
          if (!touches(from, to)) replace(from, to, new TextWidget("•", "cm-lp-bullet"));
          return;
        }
        case "TaskMarker": {
          const listMark = node.parent?.parent?.getChild("ListMark");
          const start = listMark ? listMark.from : from;
          const checked = /x/i.test(doc.sliceString(from, to));
          if (checked) lines(from, from, () => "cm-lp-task-done");
          if (!touches(start, to)) replace(start, to, new CheckboxWidget(checked));
          return;
        }
        case "HorizontalRule":
          if (!onLines(from, to)) {
            lines(from, from, () => "cm-lp-hr");
            replace(from, to);
          }
          return false;
        case "FencedCode":
        case "CodeBlock": {
          lines(from, to, (n, a, b) => `cm-lp-codeblock${n === a ? " cm-lp-codeblock-start" : ""}${n === b ? " cm-lp-codeblock-end" : ""}`);
          if (name === "FencedCode" && !touches(from, to)) {
            const firstLine = doc.lineAt(from);
            const info = node.getChild("CodeInfo");
            replace(from, firstLine.to, new TextWidget(info ? doc.sliceString(info.from, info.to) : "", "cm-lp-fence-label"));
            const close = node.lastChild;
            if (close && close.name === "CodeMark" && close.from > firstLine.to) replace(close.from, close.to);
          }
          return false;
        }
        case "BlockMath":
        case "InlineMath": {
          const marks = children(node, "MathMark");
          const display = name === "BlockMath" || marks[0].to - marks[0].from === 2;
          const tex = doc.sliceString(marks[0].to, marks.length > 1 ? marks[1].from : to).trim();
          if (!touches(from, to)) {
            replace(from, to, new MathWidget(tex, display));
          } else if (name === "BlockMath") {
            // While a formula block is being edited, its rendering follows below.
            lines(from, to, () => "cm-lp-math-src");
            if (tex) ranges.push(Decoration.widget({ widget: new MathWidget(tex, true, true), block: true, side: 1 }).range(doc.lineAt(to).to));
          } else {
            ranges.push(mark("cm-lp-math-src").range(from, to));
          }
          return false;
        }
        case "Table":
          if (!touches(from, to)) replace(from, to, new TableWidget(doc.sliceString(from, to)));
          else lines(from, to, () => "cm-lp-table-src");
          return false;
        case "Paragraph":
        case "Task": {
          const text = doc.sliceString(from, to);
          const def = FOOTNOTE_DEF.exec(text);
          if (def && doc.lineAt(from).from === from) ranges.push(mark("cm-lp-fn-def").range(from, from + def[0].length));
          for (const m of text.matchAll(CITATION)) {
            const start = from + m.index!;
            if (!literalAt(start)) ranges.push(mark("cm-lp-cite").range(start, start + m[0].length));
          }
          for (const m of text.matchAll(WIKI_LINK)) {
            const start = from + m.index!;
            const end = start + m[0].length;
            if (literalAt(start) || touches(start, end)) continue;
            // Show the alias if there is one, otherwise the target (with its #heading).
            const shownFrom = m[3] ? end - 2 - m[3].length + 1 : start + 2;
            const shownTo = m[3] ? end - 2 : start + 2 + m[1].length + (m[2]?.length ?? 0);
            replace(start, shownFrom);
            replace(shownTo, end);
            ranges.push(mark("cm-lp-link").range(shownFrom, shownTo));
          }
          for (const m of text.matchAll(FOOTNOTE_REF)) {
            const start = from + m.index!;
            const end = start + m[0].length;
            if (literalAt(start) || (def && m.index === 0)) continue;
            if (touches(start, end)) ranges.push(mark("cm-lp-fn").range(start, end));
            else replace(start, end, new TextWidget(m[1], "cm-lp-fn"));
          }
          return;
        }
      }
    },
  });

  // Replacements must not overlap: keep the outermost/earliest one.
  replaced.sort((a, b) => a.from - b.from || b.to - a.to);
  let end = -1;
  for (const r of replaced) {
    if (r.from < end) continue;
    ranges.push(r);
    end = Math.max(end, r.to);
  }
  return { decorations: Decoration.set(ranges, true), gutter: RangeSet.of(gutter, true) };
}

/** Live preview for a Markdown editor; `resolveSrc` turns image paths into URLs. */
export function livePreview(resolveSrc: (src: string) => string): Extension {
  const field = StateField.define<Preview>({
    create: (state) => build(state, resolveSrc),
    update(preview, tr) {
      if (tr.docChanged || tr.selection || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, resolveSrc);
      return preview;
    },
    provide: (f) => [EditorView.decorations.from(f, (p) => p.decorations), gutterLineClass.from(f, (p) => p.gutter)],
  });
  return [field, EditorView.editorAttributes.of({ class: "cm-lp" })];
}
