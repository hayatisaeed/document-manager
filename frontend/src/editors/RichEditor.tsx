import { forwardRef, useImperativeHandle } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Extension, Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { t } from "../i18n";

export const CALLOUT_TYPES = ["note", "tip", "important", "warning", "danger", "example", "quote"] as const;
export const CALLOUT_LABEL: Record<string, string> = {
  note: "Note",
  tip: "Tip",
  important: "Important",
  warning: "Warning",
  danger: "Danger",
  example: "Example",
  quote: "Quote",
};
export const CODE_LANGUAGES = [
// i18n: Note|Tip|Important|Warning|Danger|Example|Quote
  "python", "r", "javascript", "typescript", "bash", "sql", "json", "yaml", "xml", "css",
  "java", "c", "cpp", "csharp", "go", "rust", "ruby", "php", "kotlin", "swift", "markdown", "diff", "plaintext",
];

const lowlight = createLowlight(common);

/**
 * Citation chip stored as <span class="citation" data-cites="a;b">[@a; @b]</span>.
 * The backend's pandoc filter turns it into a real citation on export.
 */
const Citation = Node.create({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      cites: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-cites") ?? "",
        renderHTML: (attrs) => ({ "data-cites": attrs.cites }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "span.citation" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const keys = String(node.attrs.cites).split(/[;,\s]+/).filter(Boolean);
    return ["span", mergeAttributes({ class: "citation", dir: "ltr" }, HTMLAttributes), `[${keys.map((k) => "@" + k).join("; ")}]`];
  },
});

/**
 * Callout box: <div class="callout callout-tip" data-callout="tip" data-title="…">…</div>.
 * The header (type + title) is edited through small controls in a node view.
 */
const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      type: {
        default: "note",
        parseHTML: (el) => el.getAttribute("data-callout") ?? "note",
        renderHTML: (a) => ({ "data-callout": a.type }),
      },
      title: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-title") ?? "",
        renderHTML: (a) => (a.title ? { "data-title": a.title } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div.callout" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["div", mergeAttributes({ class: `callout callout-${node.attrs.type}` }, HTMLAttributes), 0];
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement("div");
      const header = document.createElement("div");
      header.className = "callout-head";
      header.contentEditable = "false";
      const select = document.createElement("select");
      for (const type of CALLOUT_TYPES) {
        const option = document.createElement("option");
        option.value = type;
        option.textContent = t(CALLOUT_LABEL[type]);
        select.append(option);
      }
      const title = document.createElement("input");
      title.placeholder = t("Title (optional)");
      title.dir = "auto";
      const body = document.createElement("div");
      body.className = "callout-body";
      header.append(select, title);
      dom.append(header, body);

      const setAttrs = (attrs: Record<string, string>) => {
        const pos = typeof getPos === "function" ? getPos() : undefined;
        if (pos === undefined) return;
        editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, ...attrs }));
      };
      select.addEventListener("change", () => setAttrs({ type: select.value }));
      title.addEventListener("change", () => setAttrs({ title: title.value }));

      const render = () => {
        dom.className = `callout callout-${current.attrs.type}`;
        select.value = current.attrs.type;
        if (document.activeElement !== title) title.value = current.attrs.title;
      };
      render();
      return {
        dom,
        contentDOM: body,
        update(updated) {
          if (updated.type !== current.type) return false;
          current = updated;
          render();
          return true;
        },
        stopEvent: (event) => header.contains(event.target as HTMLElement),
        ignoreMutation: (mutation) => header.contains(mutation.target as HTMLElement),
      };
    };
  },
});

/** Images keep their project-relative src in the saved HTML but display through the API. */
const ProjectImage = Image.extend<{ resolve: (src: string) => string } & Record<string, unknown>>({
  addOptions() {
    return { ...this.parent?.(), resolve: (s: string) => s } as never;
  },
  addNodeView() {
    return ({ node }) => {
      const img = document.createElement("img");
      img.src = (this.options as unknown as { resolve: (s: string) => string }).resolve(node.attrs.src);
      if (node.attrs.alt) img.alt = node.attrs.alt;
      if (node.attrs.title) img.title = node.attrs.title;
      return { dom: img };
    };
  },
});

/** Ctrl/Cmd+Shift+2 inserts a Persian half-space (ZWNJ), as in Microsoft Word. */
const HalfSpace = Extension.create({
  name: "halfSpace",
  addKeyboardShortcuts() {
    return { "Mod-Shift-2": () => this.editor.commands.insertContent("‌") };
  },
});

export interface RichEditorHandle {
  editor: Editor | null;
  insertCitation(keys: string[]): void;
  insertImage(src: string, alt: string): void;
}

interface Props {
  value: string;
  onChange: (html: string) => void;
  resolveSrc: (src: string) => string;
}

const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor({ value, onChange, resolveSrc }, ref) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false }, codeBlock: false }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
      ProjectImage.configure({ resolve: resolveSrc } as never),
      TableKit.configure({ table: { resizable: false } }),
      Citation,
      Callout,
      HalfSpace,
    ],
    content: value,
    shouldRerenderOnTransaction: true,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  useImperativeHandle(
    ref,
    () => ({
      editor,
      insertCitation(keys) {
        editor?.chain().focus().insertContent({ type: "citation", attrs: { cites: keys.join(";") } }).run();
      },
      insertImage(src, alt) {
        editor?.chain().focus().setImage({ src, alt }).run();
      },
    }),
    [editor],
  );

  if (!editor) return null;
  const btn = (label: string, action: () => void, active = false, title?: string) => (
    <button type="button" className={`tb ${active ? "active" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={action} title={title ?? label}>
      {label}
    </button>
  );
  const c = () => editor.chain().focus();
  const inCode = editor.isActive("codeBlock");
  const inCallout = editor.isActive("callout");

  return (
    <div className="rich">
      <div className="toolbar">
        {btn("B", () => c().toggleBold().run(), editor.isActive("bold"), t("Bold"))}
        {btn("I", () => c().toggleItalic().run(), editor.isActive("italic"), t("Italic"))}
        {btn("U", () => c().toggleUnderline().run(), editor.isActive("underline"), t("Underline"))}
        {btn("S", () => c().toggleStrike().run(), editor.isActive("strike"), t("Strikethrough"))}
        <span className="tb-sep" />
        {btn("H1", () => c().toggleHeading({ level: 1 }).run(), editor.isActive("heading", { level: 1 }))}
        {btn("H2", () => c().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
        {btn("H3", () => c().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
        {btn("¶", () => c().setParagraph().run(), editor.isActive("paragraph"), t("Paragraph"))}
        <span className="tb-sep" />
        {btn(t("• List"), () => c().toggleBulletList().run(), editor.isActive("bulletList"))}
        {btn(t("1. List"), () => c().toggleOrderedList().run(), editor.isActive("orderedList"))}
        {btn("❝", () => c().toggleBlockquote().run(), editor.isActive("blockquote"), t("Quote"))}
        {btn("—", () => c().setHorizontalRule().run(), false, t("Horizontal rule"))}
        <span className="tb-sep" />
        {btn(t("Callout"), () => (inCallout ? c().lift("callout").run() : c().wrapIn("callout", { type: "note" }).run()), inCallout, t("Callout box (note, tip, warning…)"))}
        {btn("</>", () => c().toggleCodeBlock().run(), inCode, t("Code block"))}
        {inCode && (
          <select
            className="tb-select"
            dir="ltr"
            value={editor.getAttributes("codeBlock").language ?? ""}
            onChange={(e) => c().updateAttributes("codeBlock", { language: e.target.value || null }).run()}
            aria-label={t("Code language")}
          >
            <option value="">{t("auto")}</option>
            {CODE_LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        )}
        <span className="tb-sep" />
        {btn(t("Link"), () => {
          const prev = editor.getAttributes("link").href ?? "";
          const href = prompt(t("Link URL (leave empty to remove)"), prev);
          if (href === null) return;
          if (href === "") c().unsetLink().run();
          else c().extendMarkRange("link").setLink({ href }).run();
        }, editor.isActive("link"))}
        {btn(t("Table"), () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        {editor.isActive("table") && (
          <>
            {btn(t("+Row"), () => c().addRowAfter().run())}
            {btn(t("+Col"), () => c().addColumnAfter().run())}
            {btn(t("−Row"), () => c().deleteRow().run())}
            {btn(t("−Col"), () => c().deleteColumn().run())}
            {btn(t("×Table"), () => c().deleteTable().run())}
          </>
        )}
        {btn(t("Half-space"), () => c().insertContent("‌").run(), false, t("Insert a half-space (ZWNJ) — Ctrl+Shift+2"))}
        <span className="tb-sep" />
        {btn("↶", () => c().undo().run(), false, t("Undo"))}
        {btn("↷", () => c().redo().run(), false, t("Redo"))}
      </div>
      <EditorContent editor={editor} className="rich-content prose" />
    </div>
  );
});

export default RichEditor;
