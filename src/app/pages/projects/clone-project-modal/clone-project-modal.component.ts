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
import {
  Building2,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Link2,
  Lock,
  LucideAngularModule,
  RefreshCw,
  Search,
  User,
} from 'lucide-angular';
import { ButtonComponent } from '../../../components/shared/button/button.component';
import { ModalComponent } from '../../../components/shared/modal/modal.component';
import { PathBreadcrumbsComponent } from '../../../components/shared/path-breadcrumbs/path-breadcrumbs.component';
import { Project } from '../../../models/project.model';
import { DialogService } from '../../../services/api/dialog.service';
import { GithubRepo, GithubService } from '../../../services/api/github.service';
import { TauriBridgeService } from '../../../services/api/tauri-bridge.service';
import { AuthStore } from '../../../services/state/auth.store';
import { NotificationService } from '../../../services/utils/notification.service';

const STORAGE_KEY = 'qa-tester:default-clone-path';
const DEFAULT_PATH = '~/QA-Projects';

type Tab = 'browse' | 'url';

interface RepoGroup {
  owner: string;
  ownerType: 'User' | 'Organization';
  avatarUrl: string;
  repos: GithubRepo[];
}

@Component({
  selector: 'app-clone-project-modal',
  standalone: true,
  imports: [
    FormsModule,
    ButtonComponent,
    ModalComponent,
    LucideAngularModule,
    PathBreadcrumbsComponent,
  ],
  templateUrl: './clone-project-modal.component.html',
  styleUrl: './clone-project-modal.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CloneProjectModalComponent {
  private dialog = inject(DialogService);
  private tauri = inject(TauriBridgeService);
  private github = inject(GithubService);
  private auth = inject(AuthStore);
  private notify = inject(NotificationService);

  readonly FolderIcon = FolderOpen;
  readonly SearchIcon = Search;
  readonly LinkIcon = Link2;
  readonly UserIcon = User;
  readonly OrgIcon = Building2;
  readonly LockIcon = Lock;
  readonly ChevronDownIcon = ChevronDown;
  readonly ChevronRightIcon = ChevronRight;
  readonly RefreshIcon = RefreshCw;

  open = input.required<boolean>();

  closed = output<void>();
  cloned = output<Project>();

  readonly tab = signal<Tab>('browse');
  readonly repoUrl = signal('');
  readonly localPath = signal('');
  readonly folderName = signal('');
  readonly isCloning = signal(false);
  readonly isBrowsing = signal(false);
  readonly errorMsg = signal<string | null>(null);
  readonly conflict = signal<{ targetPath: string; remoteUrl: string | null } | null>(null);

  readonly isTauri = this.tauri.isTauri;

  // Repos browser state
  readonly repos = signal<GithubRepo[]>([]);
  readonly reposLoading = signal(false);
  readonly reposError = signal<string | null>(null);
  readonly searchQuery = signal('');
  readonly expandedOwners = signal<Set<string>>(new Set());
  readonly selectedRepoId = signal<number | null>(null);

  readonly hasFetched = signal(false);

  readonly filteredGroups = computed<RepoGroup[]>(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const all = this.repos();
    const filtered = query
      ? all.filter(
          (r) =>
            r.name.toLowerCase().includes(query) ||
            r.full_name.toLowerCase().includes(query) ||
            (r.description?.toLowerCase().includes(query) ?? false),
        )
      : all;

    const groupMap = new Map<string, RepoGroup>();
    const currentUser = this.auth.user()?.login;

    for (const repo of filtered) {
      const owner = repo.owner.login;
      if (!groupMap.has(owner)) {
        groupMap.set(owner, {
          owner,
          ownerType: repo.owner.type,
          avatarUrl: repo.owner.avatar_url,
          repos: [],
        });
      }
      groupMap.get(owner)!.repos.push(repo);
    }

    const groups = Array.from(groupMap.values());
    groups.sort((a, b) => {
      if (a.owner === currentUser) return -1;
      if (b.owner === currentUser) return 1;
      return a.owner.localeCompare(b.owner);
    });
    return groups;
  });

  readonly canSubmit = computed(() => {
    return (
      this.isValidUrl(this.repoUrl()) &&
      this.localPath().trim().length > 0 &&
      this.folderName().trim().length > 0 &&
      !this.isCloning() &&
      !this.conflict()
    );
  });

  readonly targetPath = computed(() => {
    const parent = this.localPath().trim().replace(/\/+$/, '');
    const folder = this.folderName().trim();
    if (!parent || !folder) return '';
    return `${parent}/${folder}`;
  });

  constructor() {
    effect(() => {
      const url = this.repoUrl();
      const derived = this.deriveFolderName(url);
      if (derived && !this.folderName()) {
        this.folderName.set(derived);
      }
    });

    effect(() => {
      if (this.open()) {
        if (!this.localPath()) {
          const stored = localStorage.getItem(STORAGE_KEY);
          this.localPath.set(stored ?? DEFAULT_PATH);
        }
        if (this.tab() === 'browse' && !this.hasFetched()) {
          void this.loadRepos();
        }
      }
    });
  }

  setTab(t: Tab): void {
    this.tab.set(t);
    if (t === 'browse' && !this.hasFetched()) {
      void this.loadRepos();
    }
  }

  async loadRepos(force = false): Promise<void> {
    const token = this.auth.token();
    if (!token) {
      this.reposError.set('Not signed in.');
      return;
    }
    if (force) {
      this.hasFetched.set(false);
    }
    this.reposLoading.set(true);
    this.reposError.set(null);
    try {
      const list = await this.github.listAllAccessibleRepos(token);
      this.repos.set(list);
      this.hasFetched.set(true);
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        this.reposError.set('Session expired. Sign in again.');
      } else {
        this.reposError.set('Could not load repositories. Check your connection.');
      }
    } finally {
      this.reposLoading.set(false);
    }
  }

  refreshRepos(): void {
    void this.loadRepos(true);
  }

  onSearchChange(value: string): void {
    this.searchQuery.set(value);
  }

  toggleOwner(owner: string): void {
    this.expandedOwners.update((set) => {
      const next = new Set(set);
      if (next.has(owner)) next.delete(owner);
      else next.add(owner);
      return next;
    });
  }

  isOwnerExpanded(owner: string): boolean {
    return this.searchQuery().trim().length > 0 || this.expandedOwners().has(owner);
  }

  selectRepo(repo: GithubRepo): void {
    this.selectedRepoId.set(repo.id);
    this.repoUrl.set(repo.clone_url);
    this.folderName.set(repo.name);
    this.errorMsg.set(null);
    this.conflict.set(null);
  }

  onUrlChange(value: string): void {
    this.repoUrl.set(value);
    this.selectedRepoId.set(null);
    this.errorMsg.set(null);
    this.conflict.set(null);
  }

  onPathChange(value: string): void {
    this.localPath.set(value);
    this.errorMsg.set(null);
    this.conflict.set(null);
  }

  onFolderChange(value: string): void {
    this.folderName.set(value);
    this.errorMsg.set(null);
    this.conflict.set(null);
  }

  async onBrowse(): Promise<void> {
    if (!this.dialog.isTauri) {
      this.notify.info('Folder picker is available in the desktop app.');
      return;
    }
    this.isBrowsing.set(true);
    try {
      const selected = await this.dialog.pickDirectory(this.localPath() || undefined);
      if (selected) {
        this.localPath.set(selected);
        localStorage.setItem(STORAGE_KEY, selected);
      }
    } catch {
      this.notify.error('Could not open folder picker.');
    } finally {
      this.isBrowsing.set(false);
    }
  }

  onCancel(): void {
    this.reset();
    this.closed.emit();
  }

  async onSubmit(): Promise<void> {
    if (!this.canSubmit()) return;
    if (!this.tauri.isTauri) {
      this.errorMsg.set('Cloning requires the desktop app (npm run tauri:dev).');
      return;
    }

    this.isCloning.set(true);
    this.errorMsg.set(null);
    try {
      const status = await this.tauri.checkLocalRepo(this.targetPath());

      if (status.exists) {
        if (status.is_git_repo) {
          this.conflict.set({
            targetPath: this.targetPath(),
            remoteUrl: status.remote_url,
          });
          return;
        }
        this.errorMsg.set(
          'A non-git folder with this name already exists. Choose a different name or location.',
        );
        return;
      }

      await this.tauri.cloneRepo(
        this.repoUrl().trim(),
        this.targetPath(),
        this.auth.token() ?? undefined,
      );

      this.emitProject();
    } catch (err) {
      this.errorMsg.set(this.formatError(err));
    } finally {
      this.isCloning.set(false);
    }
  }

  onAddExisting(): void {
    this.emitProject();
  }

  onDismissConflict(): void {
    this.conflict.set(null);
  }

  private emitProject(): void {
    localStorage.setItem(STORAGE_KEY, this.localPath().trim());
    const project: Project = {
      id: crypto.randomUUID(),
      name: this.folderName().trim(),
      localPath: this.targetPath(),
      remoteUrl: this.repoUrl().trim(),
      testsBranch: 'tests',
      lastOpened: new Date().toISOString(),
    };
    this.cloned.emit(project);
    this.reset();
  }

  private isValidUrl(url: string): boolean {
    const trimmed = url.trim();
    if (!trimmed) return false;
    return (
      trimmed.startsWith('https://github.com/') ||
      trimmed.startsWith('git@github.com:')
    );
  }

  private deriveFolderName(url: string): string {
    const match = url.trim().match(/\/([^\/]+?)(?:\.git)?$/);
    return match ? match[1] : '';
  }

  private formatError(err: unknown): string {
    const msg = typeof err === 'string' ? err : (err as Error)?.message ?? 'Clone failed';
    if (msg.includes('Authentication') || msg.includes('403') || msg.includes('401')) {
      return 'Authentication failed. Check that your token has the "repo" scope.';
    }
    if (msg.includes('not found') || msg.includes('Repository not found')) {
      return 'Repository not found. Check the URL and your access.';
    }
    if (msg.includes('Could not resolve host') || msg.includes('Network')) {
      return 'Network error. Check your internet connection.';
    }
    if (msg.includes('Is git installed')) {
      return 'git is not installed on this system. Install from https://git-scm.com';
    }
    return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
  }

  private reset(): void {
    this.repoUrl.set('');
    this.folderName.set('');
    this.errorMsg.set(null);
    this.conflict.set(null);
    this.selectedRepoId.set(null);
    this.searchQuery.set('');
    this.expandedOwners.set(new Set());
    this.tab.set('browse');
  }
}
