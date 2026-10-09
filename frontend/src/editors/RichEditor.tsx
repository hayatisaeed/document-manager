import { forwardRef, useImperativeHandle } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Node, mergeAttributes } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";

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
    return ["span", mergeAttributes({ class: "citation" }, HTMLAttributes), `[${keys.map((k) => "@" + k).join("; ")}]`];
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
      StarterKit.configure({ link: { openOnClick: false } }),
      ProjectImage.configure({ resolve: resolveSrc } as never),
      TableKit.configure({ table: { resizable: false } }),
      Citation,
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

  return (
    <div className="rich">
      <div className="toolbar">
        {btn("B", () => c().toggleBold().run(), editor.isActive("bold"), "Bold")}
        {btn("I", () => c().toggleItalic().run(), editor.isActive("italic"), "Italic")}
        {btn("U", () => c().toggleUnderline().run(), editor.isActive("underline"), "Underline")}
        {btn("S", () => c().toggleStrike().run(), editor.isActive("strike"), "Strikethrough")}
        <span className="tb-sep" />
        {btn("H1", () => c().toggleHeading({ level: 1 }).run(), editor.isActive("heading", { level: 1 }))}
        {btn("H2", () => c().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
        {btn("H3", () => c().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
        {btn("¶", () => c().setParagraph().run(), editor.isActive("paragraph"), "Paragraph")}
        <span className="tb-sep" />
        {btn("• List", () => c().toggleBulletList().run(), editor.isActive("bulletList"))}
        {btn("1. List", () => c().toggleOrderedList().run(), editor.isActive("orderedList"))}
        {btn("❝", () => c().toggleBlockquote().run(), editor.isActive("blockquote"), "Quote")}
        {btn("</>", () => c().toggleCodeBlock().run(), editor.isActive("codeBlock"), "Code block")}
        {btn("—", () => c().setHorizontalRule().run(), false, "Horizontal rule")}
        <span className="tb-sep" />
        {btn("Link", () => {
          const prev = editor.getAttributes("link").href ?? "";
          const href = prompt("Link URL (leave empty to remove)", prev);
          if (href === null) return;
          if (href === "") c().unsetLink().run();
          else c().extendMarkRange("link").setLink({ href }).run();
        }, editor.isActive("link"))}
        {btn("Table", () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        {editor.isActive("table") && (
          <>
            {btn("+Row", () => c().addRowAfter().run())}
            {btn("+Col", () => c().addColumnAfter().run())}
            {btn("−Row", () => c().deleteRow().run())}
            {btn("−Col", () => c().deleteColumn().run())}
            {btn("×Table", () => c().deleteTable().run())}
          </>
        )}
        <span className="tb-sep" />
        {btn("↶", () => c().undo().run(), false, "Undo")}
        {btn("↷", () => c().redo().run(), false, "Redo")}
      </div>
      <EditorContent editor={editor} className="rich-content prose" />
    </div>
  );
});

export default RichEditor;
