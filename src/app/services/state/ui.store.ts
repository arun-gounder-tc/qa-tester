import { Injectable, signal } from '@angular/core';

export type ToastVariant = 'success' | 'info' | 'warning' | 'error';

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
  durationMs?: number;
}

@Injectable({ providedIn: 'root' })
export class UiStore {
  private _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  showToast(message: string, variant: ToastVariant = 'info', durationMs = 3000): void {
    const toast: Toast = {
      id: crypto.randomUUID(),
      message,
      variant,
      durationMs,
    };
    this._toasts.update((list) => [...list, toast]);
    if (durationMs > 0) {
      setTimeout(() => this.dismissToast(toast.id), durationMs);
    }
  }

  dismissToast(id: string): void {
    this._toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
