import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  input,
  output,
} from '@angular/core';
import { LucideAngularModule, X } from 'lucide-angular';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

@Component({
  selector: 'app-modal',
  standalone: true,
  imports: [LucideAngularModule],
  templateUrl: './modal.component.html',
  styleUrl: './modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ModalComponent {
  readonly XIcon = X;

  open = input.required<boolean>();
  title = input<string>('');
  description = input<string>('');
  size = input<ModalSize>('md');
  closable = input(true);

  closed = output<void>();

  readonly sizeClasses: Record<ModalSize, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-lg',
    xl: 'max-w-2xl',
  };

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open() && this.closable()) {
      this.closed.emit();
    }
  }

  onBackdropClick(): void {
    if (this.closable()) {
      this.closed.emit();
    }
  }

  onClose(): void {
    this.closed.emit();
  }
}
