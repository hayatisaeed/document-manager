import { useMemo } from "react";
import CodeMirror, { EditorView, ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";

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

const prefersDark = () => {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
};

export default function CodeEditor({
  value,
  onChange,
  language,
  editorRef,
  readOnly,
}: {
  value: string;
  onChange?: (v: string) => void;
  language: "markdown" | "latex" | "text";
  editorRef?: React.Ref<ReactCodeMirrorRef>;
  readOnly?: boolean;
}) {
  const extensions = useMemo(() => {
    const ext = [EditorView.lineWrapping];
    if (language === "markdown") ext.push(markdown());
    if (language === "latex") ext.push(StreamLanguage.define(stex));
    return ext;
  }, [language]);

  return (
    <CodeMirror
      ref={editorRef}
      className="code-editor"
      value={value}
      onChange={onChange}
      extensions={extensions}
      readOnly={readOnly}
      theme={prefersDark() ? "dark" : "light"}
      basicSetup={{ foldGutter: false, highlightActiveLineGutter: false }}
      height="100%"
    />
  );
}
