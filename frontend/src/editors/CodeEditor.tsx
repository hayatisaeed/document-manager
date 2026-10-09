import { useMemo } from "react";
import CodeMirror, { Decoration, EditorView, keymap, ReactCodeMirrorRef, ViewPlugin, type DecorationSet, type ViewUpdate } from "@uiw/react-codemirror";
import { Prec, RangeSetBuilder, type Extension } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { languages } from "@codemirror/language-data";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { usePrefs } from "../prefs";

export const ZWNJ = "‌";

/** Insert text at the cursor (replacing the selection) and focus the editor. */
export function insertAtCursor(view: EditorView | undefined, text: string) {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
  view.focus();
}

/** Wrap the selection with before/after markup (e.g. **bold**). */
export function wrapSelection(view: EditorView | undefined, before: string, after = before) {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: before + selected + after },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
  view.focus();
}

/**
 * Give every line dir="auto" so Persian lines run right-to-left and English
 * lines left-to-right, each following its first strong character. Combined with
 * perLineTextDirection, cursor movement and selection follow the same direction.
 */
const autoDirLine = Decoration.line({ attributes: { dir: "auto" } });
const lineDirection = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          builder.add(line.from, line.from, autoDirLine);
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const persianKeys = Prec.highest(keymap.of([
  {
    // Ctrl/Cmd+Shift+2 inserts a half-space (ZWNJ), as in Microsoft Word.
    key: "Mod-Shift-2",
    run: (view) => {
      insertAtCursor(view, ZWNJ);
      return true;
    },
  },
]));

export type CodeLanguage = "markdown" | "latex" | "python" | "text";

export default function CodeEditor({
  value,
  onChange,
  language,
  editorRef,
  readOnly,
  minimal,
  extraKeys,
  extraExtensions,
  onReady,
}: {
  value: string;
  onChange?: (v: string) => void;
  language: CodeLanguage;
  editorRef?: React.Ref<ReactCodeMirrorRef>;
  readOnly?: boolean;
  /** Compact mode for notebook cells: no line numbers, grows with content. */
  minimal?: boolean;
  extraKeys?: Parameters<typeof keymap.of>[0];
  /** More CodeMirror extensions, e.g. comment highlights. Keep the value stable (useMemo). */
  extraExtensions?: Extension;
  /** Called once the CodeMirror view exists (it is created after the first render). */
  onReady?: (view: EditorView) => void;
}) {
  const { dark } = usePrefs();
  const extensions = useMemo(() => {
    const ext: Extension[] = [EditorView.lineWrapping, EditorView.perLineTextDirection.of(true), lineDirection, persianKeys];
    // Highest precedence: the default keymap would otherwise turn Shift+Enter into a newline.
    if (extraKeys) ext.unshift(Prec.highest(keymap.of(extraKeys)));
    // Fenced code blocks inside Markdown are highlighted in their own language.
    if (language === "markdown") ext.push(markdown({ codeLanguages: languages }));
    if (language === "latex") ext.push(StreamLanguage.define(stex));
    if (language === "python") ext.push(python());
    if (extraExtensions) ext.push(extraExtensions);
    return ext;
  }, [language, extraKeys, extraExtensions]);

  return (
    <CodeMirror
      ref={editorRef}
      className={`code-editor lang-${language} ${minimal ? "code-editor-minimal" : ""}`}
      value={value}
      onChange={onChange}
      extensions={extensions}
      onCreateEditor={onReady}
      readOnly={readOnly}
      theme={dark ? "dark" : "light"}
      basicSetup={{
        foldGutter: false,
        highlightActiveLineGutter: false,
        lineNumbers: !minimal,
        highlightActiveLine: !minimal,
      }}
      height={minimal ? "auto" : "100%"}
    />
  );
}
