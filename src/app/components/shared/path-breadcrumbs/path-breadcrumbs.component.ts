import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ChevronRight, Home, LucideAngularModule } from 'lucide-angular';

interface Segment {
  label: string;
  isHome: boolean;
  isLast: boolean;
}

@Component({
  selector: 'app-path-breadcrumbs',
  standalone: true,
  imports: [LucideAngularModule],
  templateUrl: './path-breadcrumbs.component.html',
  styleUrl: './path-breadcrumbs.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PathBreadcrumbsComponent {
  readonly ChevronIcon = ChevronRight;
  readonly HomeIcon = Home;

  path = input.required<string>();
  emphasizeLast = input(true);

  readonly segments = computed<Segment[]>(() => {
    const raw = this.path() ?? '';
    if (!raw) return [];

    const normalized = raw
      .replace(/^\/Users\/[^/]+/, '~')
      .replace(/^\/home\/[^/]+/, '~')
      .replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');

    const parts = normalized.split(/[\/\\]/).filter(Boolean);
    return parts.map((label, idx) => ({
      label,
      isHome: idx === 0 && label === '~',
      isLast: idx === parts.length - 1,
    }));
  });
}
