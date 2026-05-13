import { Injectable, inject } from '@angular/core';
import { UiStore } from '../state/ui.store';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private ui = inject(UiStore);

  success(message: string): void {
    this.ui.showToast(message, 'success', 3000);
  }

  info(message: string): void {
    this.ui.showToast(message, 'info', 3000);
  }

  warning(message: string): void {
    this.ui.showToast(message, 'warning', 5000);
  }

  error(message: string): void {
    this.ui.showToast(message, 'error', 0);
  }
}
