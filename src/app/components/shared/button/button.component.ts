import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

@Component({
  selector: 'app-button',
  standalone: true,
  imports: [],
  templateUrl: './button.component.html',
  styleUrl: './button.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.block]': 'fullWidth()',
    '[class.w-full]': 'fullWidth()',
  },
})
export class ButtonComponent {
  variant = input<ButtonVariant>('primary');
  size = input<ButtonSize>('md');
  disabled = input(false);
  loading = input(false);
  fullWidth = input(false);
  type = input<'button' | 'submit'>('button');

  clicked = output<void>();

  readonly classes = computed(() => {
    const base =
      'inline-flex items-center justify-center gap-2 font-medium rounded transition-colors ' +
      'disabled:opacity-50 disabled:cursor-not-allowed select-none whitespace-nowrap ' +
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1';

    const sizeMap: Record<ButtonSize, string> = {
      sm: 'h-7 px-2.5 text-xs',
      md: 'h-8 px-3 text-sm',
      lg: 'h-10 px-4 text-base',
    };

    const variantMap: Record<ButtonVariant, string> = {
      primary:
        'bg-content text-content-inverse hover:bg-accent-hover ' +
        'focus-visible:ring-content/30',
      secondary:
        'bg-surface text-content border border-border hover:bg-surface-muted ' +
        'focus-visible:ring-content/20',
      ghost:
        'bg-transparent text-content-muted hover:text-content hover:bg-surface-muted ' +
        'focus-visible:ring-content/20',
      destructive:
        'bg-danger text-content-inverse hover:bg-red-600 ' +
        'focus-visible:ring-danger/30',
    };

    return [
      base,
      sizeMap[this.size()],
      variantMap[this.variant()],
      this.fullWidth() ? 'w-full' : '',
    ].join(' ');
  });

  onClick(): void {
    if (!this.disabled() && !this.loading()) {
      this.clicked.emit();
    }
  }
}
