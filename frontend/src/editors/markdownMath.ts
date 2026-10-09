/**
 * Pandoc-style TeX math for the Markdown parser: `$…$` and `$$…$$` inside a
 * paragraph, and `$$` blocks that span several lines. Produces InlineMath and
 * BlockMath nodes, each with MathMark children for the dollar signs.
 */
import type { BlockContext, Line, MarkdownConfig } from "@lezer/markdown";
import { tags } from "@lezer/highlight";

const DOLLAR = 36;
const BACKSLASH = 92;
const isSpace = (ch: number) => ch === 32 || ch === 9 || ch === 10 || ch === -1;
const isDigit = (ch: number) => ch >= 48 && ch <= 57;

/** How many enclosing blocks (quotes, list items) continue on this line. Not in the
 * public typings, but it is what the built-in FencedCode parser uses for the same check. */
const lineDepth = (line: Line) => (line as unknown as { depth: number }).depth;

function isMathFence(line: Line) {
  return line.next === DOLLAR && line.text.charCodeAt(line.pos + 1) === DOLLAR;
}

export const mathSyntax: MarkdownConfig = {
  defineNodes: [
    { name: "InlineMath", style: tags.special(tags.string) },
    { name: "BlockMath", block: true, style: tags.special(tags.string) },
    { name: "MathMark", style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== DOLLAR) return -1;
        const display = cx.char(pos + 1) === DOLLAR;
        const open = display ? 2 : 1;
        // As in pandoc, "$ 5" is not math: the opening $ must hug the formula.
        if (!display && isSpace(cx.char(pos + 1))) return -1;
        for (let i = pos + open; i < cx.end; i++) {
          const ch = cx.char(i);
          if (ch === BACKSLASH) {
            i++;
            continue;
          }
          if (ch !== DOLLAR) continue;
          if (display) {
            if (cx.char(i + 1) !== DOLLAR) continue;
          } else if (cx.char(i + 1) === DOLLAR) {
            i++; // a $$ never closes $…$ math
            continue;
          } else if (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1))) {
            continue; // the closing $ hugs the formula and is not followed by a digit ("$5 and $10")
          }
          if (i === pos + open) return -1;
          const close = i + open;
          return cx.addElement(cx.elt("InlineMath", pos, close, [cx.elt("MathMark", pos, pos + open), cx.elt("MathMark", i, close)]));
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx: BlockContext, line: Line) {
        if (!isMathFence(line)) return false;
        const from = cx.lineStart + line.pos;
        const marks = [cx.elt("MathMark", from, from + 2)];
        const rest = line.text.slice(line.pos + 2).trimEnd();
        let to: number;
        if (rest.endsWith("$$")) {
          // $$ … $$ on one line.
          to = from + 2 + rest.length;
          marks.push(cx.elt("MathMark", to - 2, to));
          cx.nextLine();
        } else {
          to = cx.lineStart + line.text.length;
          while (cx.nextLine()) {
            // Stop at the end of the enclosing quote/list, and at a blank line (pandoc ends the formula there too).
            if (lineDepth(line) < cx.depth || line.next === -1) break;
            marks.push(...line.markers); // "> " of continued lines inside a quote
            const text = line.text.trimEnd();
            if (text.endsWith("$$")) {
              to = cx.lineStart + text.length;
              marks.push(cx.elt("MathMark", to - 2, to));
              cx.nextLine();
              break;
            }
            to = cx.lineStart + line.text.length;
          }
        }
        cx.addElement(cx.elt("BlockMath", from, to, marks));
        return true;
      },
      endLeaf: (_cx, line) => isMathFence(line),
    },
  ],
};
