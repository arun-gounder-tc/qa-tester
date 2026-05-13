import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { LucideAngularModule, RefreshCw } from 'lucide-angular';
import { ButtonComponent } from '../../../components/shared/button/button.component';
import { ModalComponent } from '../../../components/shared/modal/modal.component';
import {
  DropdownItem,
  SearchableDropdownComponent,
} from '../../../components/shared/searchable-dropdown/searchable-dropdown.component';
import { EnvColor, Environment } from '../../../models/environment.model';
import { GithubService } from '../../../services/api/github.service';
import { AuthStore } from '../../../services/state/auth.store';
import { parseGithubUrl } from '../../../services/utils/repo-helpers';

interface ColorSwatch {
  value: EnvColor;
  label: string;
  classes: string;
}

type BranchesState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'loaded'; items: DropdownItem[] }
  | { kind: 'error'; message: string };

@Component({
  selector: 'app-create-environment-modal',
  standalone: true,
  imports: [
    FormsModule,
    ButtonComponent,
    ModalComponent,
    LucideAngularModule,
    SearchableDropdownComponent,
  ],
  templateUrl: './create-environment-modal.component.html',
  styleUrl: './create-environment-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CreateEnvironmentModalComponent {
  private github = inject(GithubService);
  private auth = inject(AuthStore);

  readonly RefreshIcon = RefreshCw;

  open = input.required<boolean>();
  remoteUrl = input.required<string>();

  closed = output<void>();
  created = output<Environment>();

  readonly name = signal('');
  readonly url = signal('');
  readonly branch = signal('');
  readonly color = signal<EnvColor>('dev');
  readonly isSubmitting = signal(false);

  readonly branchesState = signal<BranchesState>({ kind: 'idle' });

  readonly colorSwatches: ColorSwatch[] = [
    { value: 'dev', label: 'Dev', classes: 'bg-env-dev' },
    { value: 'uat', label: 'UAT', classes: 'bg-env-uat' },
    { value: 'staging', label: 'Staging', classes: 'bg-env-staging' },
    { value: 'prod', label: 'Prod', classes: 'bg-env-prod' },
  ];

  readonly branchItems = computed<DropdownItem[]>(() => {
    const state = this.branchesState();
    return state.kind === 'loaded' ? state.items : [];
  });

  readonly branchError = computed(() => {
    const state = this.branchesState();
    return state.kind === 'error' ? state.message : null;
  });

  readonly branchLoading = computed(() => this.branchesState().kind === 'loading');

  readonly canSubmit = computed(() => {
    return (
      this.name().trim().length > 0 &&
      this.isValidUrl(this.url()) &&
      this.branch().trim().length > 0 &&
      !this.isSubmitting()
    );
  });

  constructor() {
    effect(() => {
      if (this.open() && this.branchesState().kind === 'idle') {
        void this.loadBranches();
      }
    });
  }

  async loadBranches(force = false): Promise<void> {
    const url = this.remoteUrl();
    const parsed = parseGithubUrl(url);
    if (!parsed) {
      this.branchesState.set({
        kind: 'error',
        message: 'Could not parse repository URL.',
      });
      return;
    }
    const token = this.auth.token();
    if (!token) {
      this.branchesState.set({ kind: 'error', message: 'Not signed in.' });
      return;
    }

    if (!force && this.branchesState().kind !== 'idle') {
      return;
    }
    this.branchesState.set({ kind: 'loading' });

    try {
      const list = await firstValueFrom(
        this.github.listBranches(token, parsed.owner, parsed.repo),
      );
      const items: DropdownItem[] = list
        .filter((b) => b.name !== 'tests')
        .map((b) => ({
          value: b.name,
          label: b.name,
          protected: b.protected,
        }));
      this.branchesState.set({ kind: 'loaded', items });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      const msg =
        status === 404
          ? 'Repository not found or no access.'
          : status === 401
          ? 'Session expired. Sign in again.'
          : 'Could not load branches.';
      this.branchesState.set({ kind: 'error', message: msg });
    }
  }

  refreshBranches(): void {
    void this.loadBranches(true);
  }

  onNameChange(value: string): void {
    this.name.set(value);
  }

  onUrlChange(value: string): void {
    this.url.set(value);
  }

  onBranchChange(value: string): void {
    this.branch.set(value);
  }

  selectColor(value: EnvColor): void {
    this.color.set(value);
  }

  onCancel(): void {
    this.reset();
    this.closed.emit();
  }

  async onSubmit(): Promise<void> {
    if (!this.canSubmit()) return;
    this.isSubmitting.set(true);
    try {
      const env: Environment = {
        id: crypto.randomUUID(),
        name: this.name().trim(),
        deployedUrl: this.url().trim(),
        codeBranch: this.branch().trim(),
        color: this.color(),
      };
      this.created.emit(env);
      this.reset();
    } finally {
      this.isSubmitting.set(false);
    }
  }

  private isValidUrl(url: string): boolean {
    const trimmed = url.trim();
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  private reset(): void {
    this.name.set('');
    this.url.set('');
    this.branch.set('');
    this.color.set('dev');
  }
}
