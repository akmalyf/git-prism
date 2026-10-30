// Persisted UI state for kit components (`stateKey` options) on top of rpc.viewState.
import { viewState } from '../rpc';

export function loadState<T>(key: string | undefined, fallback: T): T {
  if (!key) return fallback;
  try {
    return viewState.get<T>(`jbui:${key}`, fallback);
  } catch {
    return fallback;
  }
}

export function saveState(key: string | undefined, value: unknown): void {
  if (!key) return;
  try {
    viewState.set(`jbui:${key}`, value);
  } catch {
    /* state unavailable */
  }
}
