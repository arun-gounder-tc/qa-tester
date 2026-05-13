import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  Check,
  ChevronsUpDown,
  LucideAngularModule,
  Search,
  Shield,
} from 'lucide-angular';

export interface DropdownItem {
  value: string;
  label: string;
  /** Optional metadata shown below or after the label */
  meta?: string;
  /** Adds a shield icon (e.g., for protected git branches) */
  protected?: boolean;
}

@Component({
  selector: 'app-searchable-dropdown',
  standalone: true,
  imports: [LucideAngularModule],
  templateUrl: './searchable-dropdown.component.html',
  styleUrl: './searchable-dropdown.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SearchableDropdownComponent implements AfterViewInit {
  private host = inject(ElementRef<HTMLElement>);

  @ViewChild('searchInput') searchInput?: ElementRef<HTMLInputElement>;

  readonly CheckIcon = Check;
  readonly ChevronsIcon = ChevronsUpDown;
  readonly SearchIcon = Search;
  readonly ShieldIcon = Shield;

  items = input<DropdownItem[]>([]);
  value = input<string | null>(null);
  placeholder = input('Select…');
  searchPlaceholder = input('Search…');
  emptyMessage = input('No matches');
  loading = input(false);
  loadingMessage = input('Loading…');
  errorMessage = input<string | null>(null);
  disabled = input(false);
  /** Use monospace font for option labels (e.g., branch names) */
  mono = input(false);

  changed = output<string>();

  readonly isOpen = signal(false);
  readonly query = signal('');

  readonly selectedItem = computed(() => {
    const v = this.value();
    return v ? this.items().find((i) => i.value === v) ?? null : null;
  });

  readonly filteredItems = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.items();
    return this.items().filter(
      (i) =>
        i.label.toLowerCase().includes(q) ||
        i.value.toLowerCase().includes(q) ||
        (i.meta?.toLowerCase().includes(q) ?? false),
    );
  });

  readonly canToggle = computed(
    () => !this.disabled() && !this.loading() && !this.errorMessage(),
  );

  constructor() {
    effect(() => {
      if (this.isOpen()) {
        queueMicrotask(() => this.searchInput?.nativeElement.focus());
      }
    });
  }

  ngAfterViewInit(): void {
    // Placeholder for future lifecycle needs
  }

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent): void {
    if (!this.isOpen()) return;
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.isOpen.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen()) this.isOpen.set(false);
  }

  toggle(event: MouseEvent): void {
    event.stopPropagation();
    if (this.canToggle()) {
      this.isOpen.update((v) => !v);
    }
  }

  onSearchChange(value: string): void {
    this.query.set(value);
  }

  select(item: DropdownItem, event: MouseEvent): void {
    event.stopPropagation();
    this.changed.emit(item.value);
    this.isOpen.set(false);
    this.query.set('');
  }

  isSelected(item: DropdownItem): boolean {
    return this.value() === item.value;
  }
}
