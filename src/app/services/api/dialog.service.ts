import { Injectable } from '@angular/core';
import { open } from '@tauri-apps/plugin-dialog';

@Injectable({ providedIn: 'root' })
export class DialogService {
  get isTauri(): boolean {
    return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
  }

  async pickDirectory(defaultPath?: string): Promise<string | null> {
    if (!this.isTauri) {
      return null;
    }
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath,
      title: 'Choose folder',
    });
    if (typeof selected === 'string') return selected;
    return null;
  }
}
