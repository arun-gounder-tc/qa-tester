import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  GitBranch,
  Globe2,
  Layers,
  LoaderCircle,
  LucideAngularModule,
  Plus,
  RefreshCw,
  Sparkles,
  TestTube2,
} from 'lucide-angular';
import { ButtonComponent } from '../../components/shared/button/button.component';
import { PathBreadcrumbsComponent } from '../../components/shared/path-breadcrumbs/path-breadcrumbs.component';
import { UserMenuComponent } from '../../components/shared/user-menu/user-menu.component';
import { CreateEnvironmentModalComponent } from './create-environment-modal/create-environment-modal.component';
import { Environment } from '../../models/environment.model';
import {
  EnvConfigEntry,
  ProjectTypeInfo,
  TauriBridgeService,
  TestsBranchStatus,
} from '../../services/api/tauri-bridge.service';
import { AuthStore } from '../../services/state/auth.store';
import { EnvironmentsStore } from '../../services/state/environments.store';
import { ProjectsStore } from '../../services/state/projects.store';
import { NotificationService } from '../../services/utils/notification.service';

export type WorktreeStatus = 'unknown' | 'preparing' | 'ready' | 'failed';
export type SyncStatus = 'idle' | 'syncing' | 'error';

type BranchPhase =
  | { kind: 'checking' }
  | { kind: 'ready' }
  | { kind: 'needs-action'; status: TestsBranchStatus }
  | { kind: 'working'; message: string }
  | { kind: 'error'; message: string };

@Component({
  selector: 'app-project-detail',
  standalone: true,
  imports: [
    ButtonComponent,
    LucideAngularModule,
    CreateEnvironmentModalComponent,
    UserMenuComponent,
    PathBreadcrumbsComponent,
  ],
  templateUrl: './project-detail.component.html',
  styleUrl: './project-detail.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectDetailComponent {
  private projects = inject(ProjectsStore);
  private envs = inject(EnvironmentsStore);
  private tauri = inject(TauriBridgeService);
  private auth = inject(AuthStore);
  private notify = inject(NotificationService);
  private router = inject(Router);

  readonly LogoIcon = TestTube2;
  readonly BackIcon = ArrowLeft;
  readonly PlusIcon = Plus;
  readonly LayersIcon = Layers;
  readonly BranchIcon = GitBranch;
  readonly GlobeIcon = Globe2;
  readonly ExternalIcon = ExternalLink;
  readonly ChevronIcon = ChevronRight;
  readonly SparklesIcon = Sparkles;
  readonly LoaderIcon = LoaderCircle;
  readonly FolderIcon = FolderOpen;
  readonly CheckIcon = CheckCircle2;
  readonly WarnIcon = AlertTriangle;
  readonly RetryIcon = RefreshCw;

  id = input.required<string>();

  readonly project = computed(() => {
    const projectId = this.id();
    return this.projects.projects().find((p) => p.id === projectId) ?? null;
  });

  readonly environments = computed(() => {
    const projectId = this.id();
    return this.envs.environmentsFor(projectId)();
  });

  readonly hasEnvironments = computed(() => this.environments().length > 0);

  readonly isCreateModalOpen = signal(false);
  readonly branchPhase = signal<BranchPhase>({ kind: 'checking' });
  readonly worktreeStatuses = signal<Record<string, WorktreeStatus>>({});
  readonly projectInfo = signal<ProjectTypeInfo | null>(null);
  readonly syncStatus = signal<SyncStatus>('idle');
  readonly lastSyncedAt = signal<number | null>(null);
  readonly syncError = signal<string | null>(null);

  readonly isTestsBranchReady = computed(() => this.branchPhase().kind === 'ready');

  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pulledProjects = new Set<string>();

  worktreeStatusFor(envId: string): WorktreeStatus {
    return this.worktreeStatuses()[envId] ?? 'unknown';
  }

  constructor() {
    let lastProjectId: string | null = null;
    effect(() => {
      const p = this.project();
      if (!p) return;
      if (p.id === lastProjectId) return;
      lastProjectId = p.id;
      void this.checkTestsBranch();
      void this.loadProjectInfo();
      void this.reconcileWorktrees();
    });

    // When tests branch becomes ready, ensure each env has a worktree.
    effect(() => {
      if (!this.isTestsBranchReady()) return;
      const envs = this.environments();
      for (const env of envs) {
        const status = this.worktreeStatusFor(env.id);
        if (status === 'unknown' || status === 'failed') {
          if (!env.worktreePath) {
            void this.createWorktreeFor(env);
          }
        }
      }
    });

    // Pull env config from tests branch once the branch is ready.
    effect(() => {
      const p = this.project();
      if (!p) return;
      if (!this.isTestsBranchReady()) return;
      if (this.pulledProjects.has(p.id)) return;
      this.pulledProjects.add(p.id);
      void this.pullEnvConfig();
    });
  }

  private async loadProjectInfo(): Promise<void> {
    const p = this.project();
    if (!p || !this.tauri.isTauri) return;
    try {
      const info = await this.tauri.detectProjectType(p.localPath);
      this.projectInfo.set(info);
    } catch {
      this.projectInfo.set(null);
    }
  }

  private async reconcileWorktrees(): Promise<void> {
    const p = this.project();
    if (!p || !this.tauri.isTauri) return;
    try {
      const entries = await this.tauri.listWorktrees(p.localPath);
      const paths = new Set(entries.map((e) => e.path));
      const next: Record<string, WorktreeStatus> = {};
      for (const env of this.environments()) {
        if (env.worktreePath && paths.has(env.worktreePath)) {
          next[env.id] = 'ready';
        } else {
          next[env.id] = 'unknown';
        }
      }
      this.worktreeStatuses.set(next);
    } catch {
      // If listing fails, leave statuses as-is.
    }
  }

  private setStatus(envId: string, status: WorktreeStatus): void {
    this.worktreeStatuses.update((m) => ({ ...m, [envId]: status }));
  }

  private async createWorktreeFor(env: Environment): Promise<void> {
    const p = this.project();
    if (!p || !this.tauri.isTauri) return;
    this.setStatus(env.id, 'preparing');
    try {
      const info = await this.tauri.createEnvWorktree(
        p.localPath,
        env.id,
        env.name,
        env.codeBranch,
        this.auth.token() ?? undefined,
      );
      this.envs.updateEnvironment(p.id, env.id, { worktreePath: info.path });
      this.setStatus(env.id, 'ready');
    } catch (err) {
      this.setStatus(env.id, 'failed');
      this.notify.error(
        `Worktree for ${env.name}: ${this.formatError(err)}`,
      );
    }
  }

  retryWorktree(env: Environment, event: Event): void {
    event.stopPropagation();
    void this.createWorktreeFor(env);
  }

  async openEnvFolder(env: Environment, event: Event): Promise<void> {
    event.stopPropagation();
    if (!env.worktreePath) return;
    try {
      await this.tauri.revealInFinder(env.worktreePath);
    } catch (err) {
      this.notify.error(`Could not open folder: ${this.formatError(err)}`);
    }
  }

  async deleteEnvironment(env: Environment): Promise<void> {
    const p = this.project();
    if (!p) return;
    if (this.tauri.isTauri && env.worktreePath) {
      try {
        await this.tauri.removeEnvWorktree(p.localPath, env.worktreePath);
      } catch {
        // Best-effort: even if worktree removal fails, drop from the store.
      }
    }
    this.envs.removeEnvironment(p.id, env.id);
    this.worktreeStatuses.update((m) => {
      const next = { ...m };
      delete next[env.id];
      return next;
    });
    this.schedulePush();
  }

  private async pullEnvConfig(): Promise<void> {
    const p = this.project();
    if (!p || !this.tauri.isTauri) return;

    this.syncStatus.set('syncing');
    try {
      const result = await this.tauri.readEnvConfig(
        p.localPath,
        this.auth.token() ?? undefined,
      );

      const remoteEnvs = result.config.environments;
      const localEnvs = this.environments();
      const isFirstSync = this.lastSyncedAt() === null;

      const remoteIds = new Set(remoteEnvs.map((e) => e.id));
      const merged: Environment[] = [];

      for (const remote of remoteEnvs) {
        const local = localEnvs.find((e) => e.id === remote.id);
        merged.push({
          id: remote.id,
          name: remote.name,
          deployedUrl: remote.deployedUrl,
          codeBranch: remote.codeBranch,
          color: remote.color as Environment['color'],
          worktreePath: local?.worktreePath,
        });
      }

      // First-time migration: if remote was empty and we have local envs,
      // keep them and push them up. After first sync, remote is authoritative.
      let needsMigrationPush = false;
      if (isFirstSync && remoteEnvs.length === 0 && localEnvs.length > 0) {
        for (const local of localEnvs) {
          merged.push(local);
        }
        needsMigrationPush = true;
      }

      this.envs.replaceEnvironments(p.id, merged);
      this.lastSyncedAt.set(Date.now());
      this.syncStatus.set('idle');
      this.syncError.set(null);

      if (needsMigrationPush) {
        this.schedulePush(true);
      }
    } catch (err) {
      this.syncStatus.set('error');
      this.syncError.set(this.formatError(err));
    }
  }

  private schedulePush(immediate = false): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
    }
    const delay = immediate ? 0 : 800;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.pushEnvConfig();
    }, delay);
  }

  private async pushEnvConfig(): Promise<void> {
    const p = this.project();
    if (!p || !this.tauri.isTauri) return;

    this.syncStatus.set('syncing');
    try {
      const entries: EnvConfigEntry[] = this.environments().map((e) => ({
        id: e.id,
        name: e.name,
        deployedUrl: e.deployedUrl,
        codeBranch: e.codeBranch,
        color: e.color,
      }));
      await this.tauri.writeEnvConfig(
        p.localPath,
        entries,
        this.auth.token() ?? undefined,
      );
      this.lastSyncedAt.set(Date.now());
      this.syncStatus.set('idle');
      this.syncError.set(null);
    } catch (err) {
      this.syncStatus.set('error');
      this.syncError.set(this.formatError(err));
    }
  }

  async syncNow(): Promise<void> {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    await this.pullEnvConfig();
    await this.pushEnvConfig();
  }

  async checkTestsBranch(): Promise<void> {
    const p = this.project();
    if (!p) return;
    if (!this.tauri.isTauri) {
      this.branchPhase.set({ kind: 'ready' });
      return;
    }
    this.branchPhase.set({ kind: 'checking' });
    try {
      const info = await this.tauri.checkTestsBranch(
        p.localPath,
        this.auth.token() ?? undefined,
      );
      if (info.status === 'ready') {
        this.branchPhase.set({ kind: 'ready' });
      } else {
        this.branchPhase.set({ kind: 'needs-action', status: info.status });
      }
    } catch (err) {
      this.branchPhase.set({
        kind: 'error',
        message: this.formatError(err),
      });
    }
  }

  async initializeTestsBranch(): Promise<void> {
    const p = this.project();
    if (!p) return;

    const phase = this.branchPhase();
    if (phase.kind !== 'needs-action') return;

    const token = this.auth.token() ?? undefined;
    let workingMessage: string;
    let successMessage: string;

    switch (phase.status) {
      case 'remote-only':
        workingMessage = 'Fetching tests branch…';
        successMessage = 'Tests branch ready';
        break;
      case 'needs-update':
        workingMessage = 'Updating tests branch setup…';
        successMessage = 'Tests branch updated';
        break;
      case 'needs-scaffold':
        workingMessage = 'Restoring scaffold…';
        successMessage = 'Scaffold restored';
        break;
      default:
        workingMessage = 'Setting up tests branch…';
        successMessage = 'Tests branch initialized';
    }

    this.branchPhase.set({ kind: 'working', message: workingMessage });

    try {
      switch (phase.status) {
        case 'remote-only':
          await this.tauri.checkoutTestsBranch(p.localPath, token);
          break;
        case 'needs-update':
          await this.tauri.updateScaffold(p.localPath, token);
          break;
        default:
          await this.tauri.bootstrapTestsBranch(p.localPath, token);
      }
      this.branchPhase.set({ kind: 'ready' });
      this.notify.success(successMessage);
    } catch (err) {
      this.branchPhase.set({
        kind: 'error',
        message: this.formatError(err),
      });
    }
  }

  retryCheck(): void {
    void this.checkTestsBranch();
  }

  openCreateModal(): void {
    this.isCreateModalOpen.set(true);
  }

  closeCreateModal(): void {
    this.isCreateModalOpen.set(false);
  }

  onEnvCreated(env: Environment): void {
    this.envs.addEnvironment(this.id(), env);
    this.isCreateModalOpen.set(false);
    this.notify.success(`${env.name} environment created`);
    this.schedulePush();
  }

  syncBadgeText(): string {
    if (this.syncStatus() === 'syncing') return 'Syncing…';
    if (this.syncStatus() === 'error') return 'Sync failed';
    const ts = this.lastSyncedAt();
    if (!ts) return 'Not synced';
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 10) return 'Synced just now';
    if (seconds < 60) return `Synced ${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `Synced ${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `Synced ${hours}h ago`;
  }

  openEnvironment(env: Environment): void {
    if (this.worktreeStatusFor(env.id) !== 'ready') {
      this.notify.info('Workspace is still preparing — try again in a moment.');
      return;
    }
    this.envs.selectEnvironment(env.id);
    void this.router.navigate([
      '/projects',
      this.id(),
      'env',
      env.id,
      'workspace',
    ]);
  }

  goBack(): void {
    void this.router.navigate(['/projects']);
  }

  badgeColor(color: Environment['color']): string {
    const map: Record<Environment['color'], string> = {
      dev: 'bg-env-dev',
      uat: 'bg-env-uat',
      staging: 'bg-env-staging',
      prod: 'bg-env-prod',
    };
    return map[color];
  }

  bannerCopy(status: TestsBranchStatus): { title: string; message: string; cta: string } {
    if (status === 'remote-only') {
      return {
        title: 'Tests branch available on remote',
        message:
          'Another tester has already initialized this. Pull it down to start working.',
        cta: 'Fetch tests branch',
      };
    }
    if (status === 'missing') {
      return {
        title: 'Set up the tests branch',
        message:
          'This project needs a dedicated branch where all tests, environment configs, and AI instructions live. Click to initialize.',
        cta: 'Initialize tests branch',
      };
    }
    if (status === 'needs-update') {
      return {
        title: 'Tests branch update available',
        message:
          'A newer version of the starter files is available (improved .gitignore, conventions). Apply the update to keep your team in sync.',
        cta: 'Apply update',
      };
    }
    return {
      title: 'Tests branch missing scaffold',
      message: 'The branch exists but its starter files are missing.',
      cta: 'Restore scaffold',
    };
  }

  private formatError(err: unknown): string {
    const msg = typeof err === 'string' ? err : (err as Error)?.message ?? 'Operation failed';
    if (msg.includes('uncommitted changes')) {
      return 'There are uncommitted changes in this project. Commit or stash them first.';
    }
    if (msg.includes('user.name') || msg.includes('user.email')) {
      return 'Set git user.name and user.email in your global git config, then try again.';
    }
    return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
  }
}
