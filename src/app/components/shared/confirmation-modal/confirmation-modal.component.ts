import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  LucideAngularModule,
  Trash2,
} from 'lucide-angular';
import { ButtonComponent, ButtonVariant } from '../button/button.component';
import { ModalComponent } from '../modal/modal.component';

export type ConfirmationVariant = 'primary' | 'destructive' | 'success';

export interface ConfirmationConfig {
  title: string;
  message: string;
  details?: string[];
  warningNote?: string;
  confirmText: string;
  cancelText?: string;
  variant: ConfirmationVariant;
  requireTyping?: string;
}

@Component({
  selector: 'app-confirmation-modal',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, ButtonComponent, ModalComponent],
  templateUrl: './confirmation-modal.component.html',
  styleUrl: './confirmation-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConfirmationModalComponent {
  open = input.required<boolean>();
  config = input.required<ConfirmationConfig>();

  confirmed = output<void>();
  cancelled = output<void>();

  readonly confirmInput = signal('');

  readonly iconImg = computed(() => {
    const variant = this.config().variant;
    if (variant === 'destructive') return Trash2;
    if (variant === 'success') return CheckCircle2;
    return Info;
  });

  readonly iconWrapClass = computed(() => {
    const variant = this.config().variant;
    const base = 'flex items-center justify-center h-9 w-9 rounded-md shrink-0';
    if (variant === 'destructive') return `${base} bg-danger-subtle text-danger`;
    if (variant === 'success') return `${base} bg-success-subtle text-success`;
    return `${base} bg-brand-subtle text-brand`;
  });

  readonly warningIcon = AlertTriangle;

  readonly buttonVariant = computed<ButtonVariant>(() =>
    this.config().variant === 'destructive' ? 'destructive' : 'primary',
  );

  readonly canConfirm = computed(() => {
    const required = this.config().requireTyping;
    if (!required) return true;
    return this.confirmInput().trim() === required;
  });

  onTypingChange(value: string): void {
    this.confirmInput.set(value);
  }

  onCancel(): void {
    this.confirmInput.set('');
    this.cancelled.emit();
  }

  onConfirm(): void {
    if (this.canConfirm()) {
      this.confirmInput.set('');
      this.confirmed.emit();
    }
  }
}
