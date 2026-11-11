import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'conductor.theme';
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

let current: Theme = read();

function apply(): void {
  if (current === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = current;
}
apply();

export function setTheme(t: Theme): void {
  current = t;
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  apply();
  for (const fn of listeners) fn();
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}

const LAST_ORG = 'conductor.lastOrg';
export const rememberOrg = (slug: string): void => {
  try {
    localStorage.setItem(LAST_ORG, slug);
  } catch {
    /* ignore */
  }
};
export const lastOrg = (): string | null => {
  try {
    return localStorage.getItem(LAST_ORG);
  } catch {
    return null;
  }
};
