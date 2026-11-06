'use client';

import { useSyncExternalStore } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark';
const preferenceKey = 'meeti.theme';
const preferenceEvent = 'meeti-theme-change';

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function subscribe(update: () => void) {
  const storageChanged = (event: StorageEvent) => {
    if (event.key !== preferenceKey && event.key !== null) return;
    document.documentElement.dataset.theme = event.newValue === 'dark' ? 'dark' : 'light';
    update();
  };
  window.addEventListener('storage', storageChanged);
  window.addEventListener(preferenceEvent, update);
  return () => {
    window.removeEventListener('storage', storageChanged);
    window.removeEventListener(preferenceEvent, update);
  };
}

function saveTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try { window.localStorage.setItem(preferenceKey, theme); }
  catch { /* The selected appearance remains active when browser storage is unavailable. */ }
  window.dispatchEvent(new Event(preferenceEvent));
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => 'light' as const);
  const dark = theme === 'dark';
  const label = dark ? 'Use light theme' : 'Use dark theme';
  return <button type="button" className="theme-toggle" data-testid="theme-toggle" aria-label={label} aria-pressed={dark} title={label} onClick={() => saveTheme(dark ? 'light' : 'dark')}>
    {dark ? <Sun size={18} aria-hidden="true" /> : <Moon size={18} aria-hidden="true" />}
    <span className="theme-label">{dark ? 'Light' : 'Dark'}</span>
  </button>;
}
