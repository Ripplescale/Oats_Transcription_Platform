'use client';

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type DisplayMode = 'user' | 'dev';
export const DISPLAY_MODE_STORAGE_KEY = 'xx-display-mode';
const BEFORE_CHANGE = 'xx-display-mode-changing';
type DisplayModeValue = { mode: DisplayMode; isDev: boolean; setMode: (mode: DisplayMode) => void };
const DisplayModeContext = createContext<DisplayModeValue | undefined>(undefined);

/** A presentation preference only: never changes capture, models, or saved content. */
export function DisplayModeProvider({ children }: { children: ReactNode }) {
  // Match the server's User view first; read the saved preference after hydration.
  const [mode, updateMode] = useState<DisplayMode>('user');
  const applyMode = useCallback((next: DisplayMode) => {
    window.dispatchEvent(new Event(BEFORE_CHANGE));
    updateMode(next);
  }, []);
  useEffect(() => {
    try { applyMode(localStorage.getItem(DISPLAY_MODE_STORAGE_KEY) === 'dev' ? 'dev' : 'user'); } catch { /* User view also works when browser storage is unavailable. */ }
    const changed = (event: StorageEvent) => {
      if (event.key === DISPLAY_MODE_STORAGE_KEY || event.key === null) applyMode(event.newValue === 'dev' ? 'dev' : 'user');
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [applyMode]);
  const setMode = useCallback((next: DisplayMode) => {
    if (next !== 'user' && next !== 'dev') return;
    applyMode(next);
    try { localStorage.setItem(DISPLAY_MODE_STORAGE_KEY, next); } catch { /* Keep the current session usable without storage. */ }
  }, [applyMode]);
  useEffect(() => { document.documentElement.dataset.displayMode = mode; }, [mode]);
  const value = useMemo(() => ({ mode, isDev: mode === 'dev', setMode }), [mode, setMode]);
  return <DisplayModeContext.Provider value={value}>{children}</DisplayModeContext.Provider>;
}

export function useDisplayMode() {
  const context = useContext(DisplayModeContext);
  if (!context) throw new Error('useDisplayMode must be used within DisplayModeProvider');
  return context;
}

/** Keep the same transcript passage in view when diagnostic rows appear or disappear. */
export function useDisplayModeScroll<T extends HTMLElement>() {
  const { mode } = useDisplayMode();
  const container = useRef<T>(null);
  const position = useRef<{ top: number; left: number; segment?: HTMLElement; offset?: number }>();
  useEffect(() => {
    const capture = () => {
      const element = container.current;
      if (!element) return;
      const edge = element.getBoundingClientRect().top;
      const segment = Array.from(element.querySelectorAll<HTMLElement>('[data-segment-id]')).find(row => row.getBoundingClientRect().bottom > edge);
      position.current = { top: element.scrollTop, left: element.scrollLeft, segment, offset: segment ? segment.getBoundingClientRect().top - edge : undefined };
    };
    window.addEventListener(BEFORE_CHANGE, capture);
    return () => window.removeEventListener(BEFORE_CHANGE, capture);
  }, []);
  useLayoutEffect(() => {
    const element = container.current, saved = position.current;
    if (!element || !saved) return;
    element.scrollTop = saved.segment && element.contains(saved.segment) && saved.offset != null
      ? element.scrollTop + saved.segment.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset
      : saved.top;
    element.scrollLeft = saved.left;
    position.current = undefined;
  }, [mode]);
  return container;
}
