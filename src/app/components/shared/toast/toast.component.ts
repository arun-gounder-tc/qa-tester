import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  LucideAngularModule,
  X,
  XCircle,
} from 'lucide-angular';
import { Toast, UiStore } from '../../../services/state/ui.store';

@Component({
  selector: 'app-toast',
  standalone: true,
  imports: [LucideAngularModule],
  templateUrl: './toast.component.html',
  styleUrl: './toast.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastComponent {
  private ui = inject(UiStore);

  readonly XIcon = X;
  readonly toasts = this.ui.toasts;

  containerClass(toast: Toast): string {
    const base =
      'flex items-start gap-3 pl-3 pr-2 py-2.5 rounded-md shadow-md border bg-surface';
    const accent: Record<Toast['variant'], string> = {
      success: 'border-border',
      info: 'border-border',
      warning: 'border-border',
      error: 'border-border',
    };
    return `${base} ${accent[toast.variant]}`;
  }

  iconColor(toast: Toast): string {
    const colors: Record<Toast['variant'], string> = {
      success: 'text-success',
      info: 'text-brand',
      warning: 'text-warning',
      error: 'text-danger',
    };
    return colors[toast.variant];
  }

  iconFor(toast: Toast) {
    const icons: Record<Toast['variant'], unknown> = {
      success: CheckCircle2,
      info: Info,
      warning: AlertTriangle,
      error: XCircle,
    };
    return icons[toast.variant];
  }

  dismiss(id: string): void {
    this.ui.dismissToast(id);
  }
}
