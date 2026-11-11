import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error' | 'info';
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const fn of listeners) fn();
};

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function toast(text: string, tone: Toast['tone'] = 'info'): void {
  const id = nextId++;
  toasts = [...toasts.slice(-3), { id, text, tone }];
  emit();
  window.setTimeout(() => dismissToast(id), tone === 'error' ? 8000 : 4000);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => toasts,
  );
}
