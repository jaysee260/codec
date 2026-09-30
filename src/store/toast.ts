/** Tiny global toast store: `showToast('Something failed', 'error')`. Rendered by src/app/Toast.tsx. */
import { create } from 'zustand';

export type ToastKind = 'info' | 'error' | 'success';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

interface ToastState {
  toasts: Toast[];
  show(text: string, kind?: ToastKind, ttlMs?: number): void;
  dismiss(id: number): void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  show(text, kind = 'info', ttlMs = 5000) {
    const id = nextId++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    if (ttlMs > 0) setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttlMs);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export const showToast = (text: string, kind: ToastKind = 'info'): void => useToastStore.getState().show(text, kind);

/** Wrap an async action so failures surface as an error toast instead of unhandled rejections. */
export async function withToast<T>(fn: () => Promise<T>, label?: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(label ? `${label}: ${msg}` : msg, 'error');
    return undefined;
  }
}
