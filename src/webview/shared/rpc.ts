// Webview side of src/core/webview.ts RpcBridge: rpc.call() → host handler, rpc.on() ← host events.
declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): any; setState(s: unknown): void };
declare global {
  interface Window {
    __INIT__: any;
  }
}

const vscode = acquireVsCodeApi();
let seq = 0;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
const listeners = new Map<string, Set<(data: any) => void>>();

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data;
  if (!m || typeof m !== 'object') return;
  if (m.kind === 'res') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error !== undefined) p.reject(new Error(m.error));
    else p.resolve(m.result);
  } else if (m.kind === 'event') {
    for (const cb of listeners.get(m.event) ?? []) cb(m.data);
  }
});

export const rpc = {
  /** Calls a host handler; rejects with the host's error message. */
  call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = ++seq;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      vscode.postMessage({ kind: 'req', id, method, params });
    });
  },
  /** Subscribes to a host event; returns an unsubscribe function. */
  on<T = any>(event: string, cb: (data: T) => void): () => void {
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
  },
};

/** The `init` object the host passed to webviewHtml(). */
export const init = <T = any>(): T => window.__INIT__ as T;

/** Per-webview persisted UI state (survives hide/show and reloads). */
export const viewState = {
  get<T = any>(key: string, fallback: T): T {
    const s = vscode.getState() || {};
    return key in s ? (s[key] as T) : fallback;
  },
  set(key: string, value: unknown): void {
    vscode.setState({ ...(vscode.getState() || {}), [key]: value });
  },
};
