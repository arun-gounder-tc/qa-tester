import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-claude-logo',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size"
      [attr.height]="size"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        d="M12 2c.45 3.8.95 5.8 1.95 6.8s3 1.5 6.8 1.95c-3.8.45-5.8.95-6.8 1.95s-1.5 3-1.95 6.8c-.45-3.8-.95-5.8-1.95-6.8s-3-1.5-6.8-1.95c3.8-.45 5.8-.95 6.8-1.95S11.55 5.8 12 2z"
      />
      <path
        d="M12 2c.45 3.8.95 5.8 1.95 6.8s3 1.5 6.8 1.95c-3.8.45-5.8.95-6.8 1.95s-1.5 3-1.95 6.8c-.45-3.8-.95-5.8-1.95-6.8s-3-1.5-6.8-1.95c3.8-.45 5.8-.95 6.8-1.95S11.55 5.8 12 2z"
        transform="rotate(45 12 12)"
      />
    </svg>
  `,
})
export class ClaudeLogoComponent {
  @Input() size = 16;
}
