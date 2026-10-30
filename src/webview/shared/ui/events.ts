// Minimal event plumbing shared by the UI kit (no DOM): Disposable, DisposableStore, Emitter.
export interface Disposable {
  dispose(): void;
}

export function toDisposable(fn: () => void): Disposable {
  let done = false;
  return {
    dispose() {
      if (done) return;
      done = true;
      fn();
    },
  };
}

export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  add<T extends Disposable>(d: T): T {
    if (this.disposed) d.dispose();
    else this.items.push(d);
    return d;
  }

  dispose(): void {
    this.disposed = true;
    const items = this.items;
    this.items = [];
    for (const d of items) d.dispose();
  }
}

export type Event<T> = (listener: (e: T) => void) => Disposable;

export class Emitter<T> implements Disposable {
  private listeners = new Set<(e: T) => void>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error(err);
      }
    }
  }

  get hasListeners(): boolean {
    return this.listeners.size > 0;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
