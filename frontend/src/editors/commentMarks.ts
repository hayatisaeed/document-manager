/**
 * Highlights for comment threads in the editors.
 *
 * A thread remembers the text it is about plus a little context on each side
 * (like the W3C "text quote selector"), so it can be found again after the
 * document has been edited, by the author or by a co-author after a pull.
 */
import { EditorView, Decoration, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension as CMExtension } from "@codemirror/state";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration as PMDecoration, DecorationSet as PMDecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface TextAnchor {
  type: "text";
  quote: string;
  prefix: string;
  suffix: string;
}

export interface MarkRange {
  id: string;
  from: number;
  to: number;
}

const CONTEXT = 32;

export function makeAnchor(text: string, from: number, to: number): TextAnchor {
  return {
    type: "text",
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - CONTEXT), from),
    suffix: text.slice(to, to + CONTEXT),
  };
}

function commonSuffix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefix(a: string, b: string) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Where the anchored text is now, choosing the occurrence whose surroundings match best. */
export function locate(text: string, anchor: TextAnchor): { from: number; to: number } | null {
  const { quote, prefix, suffix } = anchor;
  if (!quote) return null;
  let best: { from: number; to: number } | null = null;
  let bestScore = -1;
  for (let i = text.indexOf(quote), guard = 0; i !== -1 && guard < 5000; i = text.indexOf(quote, i + 1), guard++) {
    const end = i + quote.length;
    const score =
      commonSuffix(text.slice(Math.max(0, i - prefix.length), i), prefix) + commonPrefix(text.slice(end, end + suffix.length), suffix);
    if (score > bestScore) {
      bestScore = score;
      best = { from: i, to: end };
    }
  }
  return best;
}

// ---------------------------------------------------------------- CodeMirror

export const setCommentMarks = StateEffect.define<{ ranges: MarkRange[]; active: string | null }>();

const markFor = (id: string, active: boolean) =>
  Decoration.mark({ class: active ? "comment-mark comment-mark-active" : "comment-mark", attributes: { "data-thread": id } });

export const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCommentMarks)) {
        const len = tr.state.doc.length;
        const ranges = e.value.ranges
          .filter((r) => r.from < r.to && r.to <= len)
          .sort((a, b) => a.from - b.from || a.to - b.to)
          .map((r) => markFor(r.id, r.id === e.value.active).range(r.from, r.to));
        value = Decoration.set(ranges, true);
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Comment highlights for a CodeMirror editor; clicking one calls onClick with the thread id. */
export function commentExtension(onClick: (id: string) => void): CMExtension {
  return [
    commentField,
    EditorView.domEventHandlers({
      click(event) {
        const el = (event.target as HTMLElement).closest?.("[data-thread]");
        if (el) onClick(el.getAttribute("data-thread")!);
        return false;
      },
    }),
  ];
}

// ---------------------------------------------------------------- ProseMirror (rich text)

/**
 * The rich-text document as plain text (blocks separated by "\n"), with the
 * ProseMirror position of every character, so text anchors work the same way
 * as in the plain-text editors.
 */
export function proseText(doc: PMNode): { text: string; pos: number[] } {
  const parts: string[] = [];
  const pos: number[] = [];
  let length = 0;
  let lastNewline = true;
  doc.descendants((node, p) => {
    if (node.isText && node.text) {
      parts.push(node.text);
      for (let k = 0; k < node.text.length; k++) pos.push(p + k);
      length += node.text.length;
      lastNewline = false;
    } else if (node.isBlock && !lastNewline && length) {
      parts.push("\n");
      pos.push(p);
      length += 1;
      lastNewline = true;
    }
    return true;
  });
  return { text: parts.join(""), pos };
}

/** Index of the first character at or after ProseMirror position `p`. */
export function textIndex(pos: number[], p: number): number {
  let lo = 0;
  let hi = pos.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pos[mid] < p) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const commentPluginKey = new PluginKey<PMDecorationSet>("comments");

export const CommentMarks = Extension.create<{ onClick: { current: ((id: string) => void) | null } }>({
  name: "commentMarks",
  addOptions() {
    return { onClick: { current: null } };
  },
  addProseMirrorPlugins() {
    const onClick = this.options.onClick;
    return [
      new Plugin<PMDecorationSet>({
        key: commentPluginKey,
        state: {
          init: () => PMDecorationSet.empty,
          apply(tr, value) {
            const meta = tr.getMeta(commentPluginKey) as { ranges: MarkRange[]; active: string | null } | undefined;
            if (meta) {
              const { pos } = proseText(tr.doc);
              const decos = meta.ranges
                .filter((r) => r.from < r.to && r.to <= pos.length)
                .map((r) =>
                  PMDecoration.inline(
                    pos[r.from],
                    pos[r.to - 1] + 1,
                    { class: r.id === meta.active ? "comment-mark comment-mark-active" : "comment-mark", "data-thread": r.id },
                    { thread: r.id },
                  ),
                );
              return PMDecorationSet.create(tr.doc, decos);
            }
            return value.map(tr.mapping, tr.doc);
          },
        },
        props: {
          decorations(state) {
            return commentPluginKey.getState(state);
          },
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement).closest?.("[data-thread]");
            if (el) onClick.current?.(el.getAttribute("data-thread")!);
            return false;
          },
        },
      }),
    ];
  },
});
