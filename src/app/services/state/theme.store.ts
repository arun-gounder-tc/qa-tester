import { Injectable, computed, signal } from '@angular/core';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'qa-tester:theme';

@Injectable({ providedIn: 'root' })
export class ThemeStore {
  private _mode = signal<ThemeMode>(this.loadMode());
  private _systemDark = signal<boolean>(this.detectSystemDark());

  readonly mode = this._mode.asReadonly();
  readonly isDark = computed(() => {
    const mode = this._mode();
    return mode === 'dark' || (mode === 'system' && this._systemDark());
  });

  constructor() {
    this.apply();
    if (typeof window !== 'undefined' && 'matchMedia' in window) {
      const media = window.matchMedia('(prefers-color-scheme: dark)');
      media.addEventListener('change', (e) => {
        this._systemDark.set(e.matches);
        this.apply();
      });
    }
  }

  setMode(mode: ThemeMode): void {
    this._mode.set(mode);
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore
    }
    this.apply();
  }

  toggle(): void {
    // Cycle: light → dark → system → light
    const next: ThemeMode =
      this._mode() === 'light'
        ? 'dark'
        : this._mode() === 'dark'
          ? 'system'
          : 'light';
    this.setMode(next);
  }

  private apply(): void {
    if (typeof document === 'undefined') return;
    const dark = this.isDark();
    document.documentElement.classList.toggle('dark', dark);
  }

  private loadMode(): ThemeMode {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === 'light' || raw === 'dark' || raw === 'system') {
        return raw;
      }
    } catch {
      // ignore
    }
    return 'system';
  }

  private detectSystemDark(): boolean {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
}
