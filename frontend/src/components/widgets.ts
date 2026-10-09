/**
 * Live Jupyter widgets (ipywidgets) for the notebook editor.
 *
 * The official @jupyter-widgets/html-manager renders the widgets; this file
 * connects it to the kernel through the backend:
 *   kernel → browser: long-polling /kernel/events/ (comm_open, comm_msg, status, outputs)
 *   browser → kernel: POST /kernel/comm/
 * Loaded lazily (it is large) when a notebook has a running kernel.
 */
import { HTMLManager } from "@jupyter-widgets/html-manager/lib/htmlmanager";
import * as outputWidgets from "@jupyter-widgets/html-manager/lib/output";
import * as widgetsBase from "@jupyter-widgets/base";
import * as widgetsControls from "@jupyter-widgets/controls";
import "@jupyter-widgets/controls/css/labvariables.css";
import type { ICallbacks, IClassicComm } from "@jupyter-widgets/base";
import "@jupyter-widgets/base/css/index.css";
import "@jupyter-widgets/controls/css/widgets.built.css";
import "@lumino/widgets/style/index.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import { api, qs } from "../api";

interface KernelEvent {
  seq: number;
  msg_type: string;
  parent_msg_id: string;
  content: Record<string, unknown> & { comm_id?: string; target_name?: string; data?: unknown; execution_state?: string };
  metadata: Record<string, unknown>;
  buffers: string[];
  captured: boolean;
}

const OUTPUT_TYPES = new Set(["stream", "display_data", "execute_result", "error", "update_display_data"]);

function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function toBase64(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): DataView {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return new DataView(bytes.buffer);
}

class BridgeComm implements IClassicComm {
  private onMsg?: (msg: unknown) => void;
  private onClose?: (msg: unknown) => void;
  constructor(
    private bridge: WidgetBridge,
    public comm_id: string,
    public target_name: string,
  ) {}

  open(data: unknown, callbacks?: ICallbacks, metadata?: Record<string, unknown>, buffers?: (ArrayBuffer | ArrayBufferView)[]): string {
    return this.bridge.send("comm_open", { comm_id: this.comm_id, target_name: this.target_name, data }, callbacks, metadata, buffers);
  }
  send(data: unknown, callbacks?: ICallbacks, metadata?: Record<string, unknown>, buffers?: (ArrayBuffer | ArrayBufferView)[]): string {
    return this.bridge.send("comm_msg", { comm_id: this.comm_id, data }, callbacks, metadata, buffers);
  }
  close(data?: unknown, callbacks?: ICallbacks, metadata?: Record<string, unknown>, buffers?: (ArrayBuffer | ArrayBufferView)[]): string {
    this.bridge.comms.delete(this.comm_id);
    return this.bridge.send("comm_close", { comm_id: this.comm_id, data: data ?? {} }, callbacks, metadata, buffers);
  }
  on_msg(callback: (x: unknown) => void) {
    this.onMsg = callback;
  }
  on_close(callback: (x: unknown) => void) {
    this.onClose = callback;
  }
  handle(msg: unknown) {
    this.onMsg?.(msg);
  }
  handleClose(msg: unknown) {
    this.onClose?.(msg);
  }
}

class BridgeManager extends HTMLManager {
  constructor(private bridge: WidgetBridge) {
    super();
  }
  // Models created from the browser side (rare) get a comm to the kernel.
  async _create_comm(target_name: string, model_id?: string, data?: unknown, metadata?: Record<string, unknown>, buffers?: (ArrayBuffer | ArrayBufferView)[]) {
    const comm = new BridgeComm(this.bridge, model_id ?? uuid(), target_name);
    this.bridge.comms.set(comm.comm_id, comm);
    if (data !== undefined) comm.open(data, undefined, metadata, buffers);
    return comm;
  }
  _get_comm_info() {
    return Promise.resolve({});
  }
  // html-manager loads these with an AMD require(); use the bundled modules instead.
  protected loadClass(className: string, moduleName: string, moduleVersion: string): Promise<any> {
    const modules: Record<string, Record<string, unknown>> = {
      "@jupyter-widgets/base": widgetsBase,
      "@jupyter-widgets/controls": widgetsControls,
      "@jupyter-widgets/output": outputWidgets,
    };
    const module = modules[moduleName];
    if (module?.[className]) return Promise.resolve(module[className]);
    return Promise.reject(new Error(`Widget ${moduleName}.${className}@${moduleVersion} is not available in this app.`));
  }
}

export class WidgetBridge {
  manager: BridgeManager;
  comms = new Map<string, BridgeComm>();
  private callbacks = new Map<string, ICallbacks>();
  /** Output widget comm id → request id it captures. Tracked from the raw message
   *  order, because models apply state updates asynchronously. */
  private capturing = new Map<string, string>();
  private since = 0;
  private session: number | null = null;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private url: (path: string) => string, private path: string) {
    this.manager = new BridgeManager(this);
    this.poll();
  }

  /** Send a message to the kernel; returns its id right away (ipywidgets needs it synchronously). */
  send(msgType: string, content: Record<string, unknown>, callbacks?: ICallbacks, metadata?: Record<string, unknown>, buffers?: (ArrayBuffer | ArrayBufferView)[]): string {
    const msgId = uuid();
    if (callbacks) this.callbacks.set(msgId, callbacks);
    api
      .post(this.url("kernel/comm/"), {
        path: this.path,
        msg_type: msgType,
        msg_id: msgId,
        content,
        metadata: metadata ?? {},
        buffers: (buffers ?? []).map(toBase64),
      })
      .catch((e) => console.warn("widget message not delivered", e));
    return msgId;
  }

  stop() {
    this.stopped = true;
  }

  private async poll() {
    while (!this.stopped) {
      try {
        const res = await api.get<{ seq: number; events: KernelEvent[]; running: boolean; session?: number }>(
          this.url("kernel/events/") + qs({ path: this.path, since: this.since, wait: 20 }),
        );
        if (!res.running) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (this.session !== null && res.session !== this.session) {
          // Kernel restarted: its widgets are gone.
          this.reset();
          this.since = 0;
          this.session = res.session ?? null;
          continue;
        }
        this.session = res.session ?? null;
        this.since = res.seq;
        for (const event of res.events) this.queue = this.queue.then(() => this.dispatch(event)).catch((e) => console.warn(e));
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private reset() {
    this.comms.clear();
    this.capturing.clear();
    this.callbacks.clear();
    this.manager.clear_state().catch(() => {});
  }

  private message(event: KernelEvent) {
    return {
      header: { msg_type: event.msg_type, msg_id: uuid() },
      parent_header: { msg_id: event.parent_msg_id },
      content: event.content,
      metadata: event.metadata,
      buffers: event.buffers.map(fromBase64),
      channel: "iopub",
    };
  }

  private async dispatch(event: KernelEvent) {
    const msg = this.message(event);
    const commId = event.content.comm_id as string | undefined;
    this.trackCapture(event);
    switch (event.msg_type) {
      case "comm_open": {
        if (event.content.target_name !== "jupyter.widget") return;
        const comm = new BridgeComm(this, commId!, "jupyter.widget");
        this.comms.set(commId!, comm);
        await this.manager.handle_comm_open(comm, msg as never);
        return;
      }
      case "comm_msg":
        this.comms.get(commId!)?.handle(msg);
        return;
      case "comm_close":
        this.comms.get(commId!)?.handleClose(msg);
        this.comms.delete(commId!);
        return;
    }
    const cb = this.callbacks.get(event.parent_msg_id);
    if (event.msg_type === "status") {
      cb?.iopub?.status?.(msg as never);
      if (event.content.execution_state === "idle") this.callbacks.delete(event.parent_msg_id);
      return;
    }
    // Outputs captured by an Output widget go into that widget.
    if (event.captured) await this.routeToOutputWidgets(event);
    else if (OUTPUT_TYPES.has(event.msg_type)) cb?.iopub?.output?.(msg as never);
  }

  private trackCapture(event: KernelEvent) {
    const commId = event.content.comm_id as string | undefined;
    const data = (event.content.data ?? {}) as { state?: Record<string, unknown> };
    const state = data.state ?? {};
    if (!commId) return;
    if (event.msg_type === "comm_open" && state._model_name === "OutputModel") this.capturing.set(commId, String(state.msg_id ?? ""));
    else if (event.msg_type === "comm_msg" && this.capturing.has(commId) && "msg_id" in state) this.capturing.set(commId, String(state.msg_id));
    else if (event.msg_type === "comm_close") this.capturing.delete(commId);
  }

  private async routeToOutputWidgets(event: KernelEvent) {
    for (const [commId, msgId] of this.capturing) {
      if (msgId !== event.parent_msg_id || !this.manager.has_model(commId)) continue;
      const model: any = await this.manager.get_model(commId);
      if (event.msg_type === "clear_output") {
        model.clear_output(Boolean(event.content.wait));
      } else {
        const output = { output_type: event.msg_type === "update_display_data" ? "display_data" : event.msg_type, ...event.content };
        model.outputs.add(output);
      }
    }
  }

  /** Render the view of `modelId` into `el`; waits briefly for the model to arrive. */
  async render(modelId: string, el: HTMLElement): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
      if (this.manager.has_model(modelId)) {
        const model = await this.manager.get_model(modelId);
        const view = await this.manager.create_view(model);
        await this.manager.display_view(view as never, el);
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
}
