import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import { api, qs } from "../api";
import FilePicker from "../components/FilePicker";
import { toast, toastError } from "../components/Toast";
import { t } from "../i18n";
import { usePrefs } from "../prefs";
import { basename, relativePath, resolveLink } from "../util";
import { useWorkspace } from "./context";
import { DocSide, useSideTab } from "./DocSide";
import type { DrawingApi } from "./DrawingEditor";
import { FileHead, useAutosave } from "./FileHead";

// Excalidraw's fonts are copied to /excalidraw/fonts by scripts/copy-vendor.mjs, so drawings work offline.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/excalidraw/";

const DrawingEditor = lazy(() => import("./DrawingEditor"));

/** Excalidraw drawings (.excalidraw): mind maps, diagrams, sketches. Saved as JSON, so git can diff them. */
export default function DrawingView({ path }: { path: string }) {
  const { p, tree, manifest, setView, refresh } = useWorkspace();
  const { dark, lang } = usePrefs();
  const [initial, setInitial] = useState<ExcalidrawInitialDataState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useSideTab();
  const [picking, setPicking] = useState(false);
  const serialize = useRef<(() => string) | null>(null);
  const drawing = useRef<DrawingApi | null>(null);

  const { saveState, markDirty } = useAutosave(path, async () => {
    if (!serialize.current) return;
    const data = JSON.parse(serialize.current());
    data.source = "document-manager"; // not the app's URL, which differs between computers
    await api.put(p("file/") + qs({ path }), { content: JSON.stringify(data, null, 2) });
  });

  useEffect(() => {
    api
      .get<{ content: string }>(p("file/") + qs({ path }))
      .then((r) => {
        if (!r.content.trim()) return setInitial({ elements: [], appState: {} });
        const scene = JSON.parse(r.content);
        if (scene?.type !== "excalidraw") throw new Error(t("This is not an Excalidraw drawing."));
        setInitial({ elements: scene.elements ?? [], appState: scene.appState ?? {}, files: scene.files ?? {}, scrollToContent: true });
      })
      .catch((e) => setError(e instanceof SyntaxError ? t("The drawing file is damaged: {error}", { error: e.message }) : e.message));
  }, [p, path]);

  const openLink = (link: string) => {
    const target = resolveLink(path, link);
    if (!target || !tree.some((i) => i.path === target && i.type === "file")) return false;
    setView({ name: "editor", path: target });
    return true;
  };

  const linkShape = () => {
    if (!drawing.current?.selectedCount()) {
      toast(t("Select one or more shapes first."));
      return;
    }
    setPicking(true);
  };

  const saveImage = async () => {
    if (!drawing.current) return;
    try {
      const blob = await drawing.current.toPng();
      const name = basename(path).replace(/\.excalidraw$/i, "") + ".png";
      const form = new FormData();
      form.append("folder", "attachments");
      form.append("files", new File([blob], name, { type: "image/png" }));
      await api.post(p("upload/"), form);
      await refresh();
      toast(t("Saved attachments/{name}. Insert it into a chapter with the Image button.", { name }), "success");
    } catch (e) {
      toastError(e);
    }
  };

  if (error) {
    return (
      <div className="empty">
        <h2>{t("Could not open the drawing")}</h2>
        <p className="error-text">{error}</p>
      </div>
    );
  }

  return (
    <div className="doc">
      <FileHead path={path} saveState={saveState} side={side === "links" ? side : null} setSide={setSide} withComments={false}>
        <span className="badge">{t("Drawing")}</span>
        <button className="btn btn-sm" onClick={linkShape} title={t("Clicking the shape's link icon then opens that file")}>
          {t("Link shape to file…")}
        </button>
        <button className="btn btn-sm" onClick={saveImage} title={t("Export as a PNG image into attachments/, to use in chapters and exports")}>
          {t("Save as image")}
        </button>
      </FileHead>
      <div className="doc-row">
        <div className="drawing">
          {initial ? (
            <Suspense fallback={<div className="pad muted">{t("Loading the drawing editor…")}</div>}>
              <DrawingEditor
                initial={initial}
                dark={dark}
                lang={lang}
                onChange={(fn) => {
                  serialize.current = fn;
                  markDirty();
                }}
                onReady={(a) => (drawing.current = a)}
                onOpenLink={openLink}
              />
            </Suspense>
          ) : (
            <div className="pad muted">{t("Loading…")}</div>
          )}
        </div>
        {side === "links" && <DocSide path={path} tab="links" setTab={setSide} />}
      </div>
      {picking && (
        <FilePicker
          title={t("Link shape to file…")}
          tree={tree}
          exclude={[path]}
          titles={Object.fromEntries(Object.entries(manifest.files).map(([k, v]) => [k, v.title]))}
          onClose={() => setPicking(false)}
          onPick={(target) => {
            setPicking(false);
            drawing.current?.linkSelected(relativePath(path, target));
          }}
        />
      )}
    </div>
  );
}
