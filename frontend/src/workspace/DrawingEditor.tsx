/**
 * The Excalidraw canvas. Loaded lazily (it is large), from DrawingView.
 */
import { useRef } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  hashElementsVersion,
  newElementWith,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

export interface DrawingApi {
  /** Shapes currently selected. */
  selectedCount(): number;
  /** Put a link on the selected shapes (empty string removes it). */
  linkSelected(link: string): void;
  toPng(): Promise<Blob>;
}

export default function DrawingEditor({
  initial,
  dark,
  lang,
  onChange,
  onReady,
  onOpenLink,
}: {
  initial: ExcalidrawInitialDataState;
  dark: boolean;
  lang: "en" | "fa";
  /** Called when the drawing changed, with a function that serialises it to the .excalidraw JSON. */
  onChange: (serialize: () => string) => void;
  onReady: (api: DrawingApi) => void;
  /** Open a link on a shape; return true when handled inside the app. */
  onOpenLink: (link: string) => boolean;
}) {
  const lastKey = useRef<string | null>(null);

  const ready = (api: ExcalidrawImperativeAPI) => {
    const selected = () => {
      const ids = api.getAppState().selectedElementIds;
      return api.getSceneElements().filter((el) => ids[el.id]);
    };
    onReady({
      selectedCount: () => selected().length,
      linkSelected(link) {
        const ids = api.getAppState().selectedElementIds;
        api.updateScene({
          elements: api.getSceneElementsIncludingDeleted().map((el) => (ids[el.id] ? newElementWith(el, { link: link || null }) : el)),
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      },
      toPng: () =>
        exportToBlob({
          elements: api.getSceneElements(),
          appState: { ...api.getAppState(), exportBackground: true },
          files: api.getFiles(),
          mimeType: "image/png",
          exportPadding: 16,
        }),
    });
  };

  return (
    <Excalidraw
      initialData={initial}
      excalidrawAPI={ready}
      theme={dark ? "dark" : "light"}
      langCode={lang === "fa" ? "fa-IR" : "en"}
      UIOptions={{ canvasActions: { toggleTheme: false, saveToActiveFile: false } }}
      onChange={(elements, appState, files) => {
        // onChange fires on every pointer move; only treat real content changes as edits.
        const key = `${hashElementsVersion(elements)}|${appState.viewBackgroundColor}|${Object.keys(files).length}`;
        if (lastKey.current === null) {
          lastKey.current = key; // the initial render
          return;
        }
        if (key === lastKey.current) return;
        lastKey.current = key;
        onChange(() => serializeAsJSON(elements, appState, files, "local"));
      }}
      onLinkOpen={(element, event) => {
        if (element.link && onOpenLink(element.link)) event.preventDefault();
      }}
    />
  );
}
