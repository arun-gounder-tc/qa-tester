import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { FormsModule } from '@angular/forms';
import {
  AfterViewChecked,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  signal,
  ViewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
import {
  ArrowLeft,
  ChevronDown,
  FileCode2,
  Folder,
  FolderOpen,
  LoaderCircle,
  LucideAngularModule,
  MessageSquare,
  Plus,
  Search,
  Send,
  Sparkles,
  TestTube2,
  Trash2,
} from 'lucide-angular';
import { UserMenuComponent } from '../../components/shared/user-menu/user-menu.component';
import { Environment } from '../../models/environment.model';
import {
  ChatEnvContext,
  ProjectTypeInfo,
  TauriBridgeService,
  TestFile,
} from '../../services/api/tauri-bridge.service';
import { ChatStore } from '../../services/state/chat.store';
import { EnvironmentsStore } from '../../services/state/environments.store';
import { ProjectsStore } from '../../services/state/projects.store';
import { NotificationService } from '../../services/utils/notification.service';

interface TestFileGroup {
  directory: string;
  files: TestFile[];
}

type FilesPhase =
  | { kind: 'loading' }
  | { kind: 'ready'; files: TestFile[] }
  | { kind: 'error'; message: string };

@Component({
  selector: 'app-workspace',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, UserMenuComponent],
  templateUrl: './workspace.component.html',
  styleUrl: './workspace.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceComponent implements AfterViewChecked {
  private projects = inject(ProjectsStore);
  private envs = inject(EnvironmentsStore);
  private chat = inject(ChatStore);
  private tauri = inject(TauriBridgeService);
  private notify = inject(NotificationService);
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);

  readonly LogoIcon = TestTube2;
  readonly BackIcon = ArrowLeft;
  readonly LoaderIcon = LoaderCircle;
  readonly ChevronDownIcon = ChevronDown;
  readonly FolderIcon = Folder;
  readonly FolderOpenIcon = FolderOpen;
  readonly FileIcon = FileCode2;
  readonly PlusIcon = Plus;
  readonly SparklesIcon = Sparkles;
  readonly ChatIcon = MessageSquare;
  readonly SearchIcon = Search;
  readonly SendIcon = Send;
  readonly TrashIcon = Trash2;

  id = input.required<string>();
  envId = input.required<string>();

  @ViewChild('envMenu') envMenu?: ElementRef<HTMLElement>;
  @ViewChild('messagesEnd') messagesEnd?: ElementRef<HTMLElement>;
  @ViewChild('chatInput') chatInput?: ElementRef<HTMLTextAreaElement>;

  readonly project = computed(() => {
    const projectId = this.id();
    return this.projects.projects().find((p) => p.id === projectId) ?? null;
  });

  readonly environments = computed(() => {
    return this.envs.environmentsFor(this.id())();
  });

  readonly activeEnv = computed(() => {
    const id = this.envId();
    return this.environments().find((e) => e.id === id) ?? null;
  });

  readonly otherEnvs = computed(() => {
    const id = this.envId();
    return this.environments().filter((e) => e.id !== id);
  });

  readonly filesPhase = signal<FilesPhase>({ kind: 'loading' });
  readonly isEnvMenuOpen = signal(false);
  readonly selectedFile = signal<TestFile | null>(null);
  readonly selectedFileContent = signal<string | null>(null);

  readonly chatAvailable = signal<boolean | null>(null);
  readonly projectInfo = signal<ProjectTypeInfo | null>(null);
  readonly isSending = signal(false);
  readonly draft = signal('');

  // Resizable panel widths (in px). Persisted to localStorage.
  readonly leftWidth = signal(this.loadWidth('qa-tester:workspace-left-width', 288, 200, 480));
  readonly rightWidth = signal(this.loadWidth('qa-tester:workspace-right-width', 360, 240, 720));
  readonly draggingDivider = signal<'left' | 'right' | null>(null);
  private dragStartX = 0;
  private dragStartWidth = 0;

  readonly highlightedCode = computed<SafeHtml | null>(() => {
    const content = this.selectedFileContent();
    const file = this.selectedFile();
    if (content == null || !file) return null;
    const lang = file.name.endsWith('.ts') ? 'typescript' : 'javascript';
    try {
      const html = hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
      return this.sanitizer.bypassSecurityTrustHtml(html);
    } catch {
      return this.sanitizer.bypassSecurityTrustHtml(this.escapeHtml(content));
    }
  });
  readonly messages = computed(() => {
    return this.chat.messagesFor(this.id(), this.envId())();
  });
  readonly hasMessages = computed(() => this.messages().length > 0);

  private shouldScrollToBottom = false;

  readonly groupedFiles = computed<TestFileGroup[]>(() => {
    const phase = this.filesPhase();
    if (phase.kind !== 'ready') return [];
    const groups = new Map<string, TestFile[]>();
    for (const f of phase.files) {
      const dir = f.directory || '';
      const arr = groups.get(dir) ?? [];
      arr.push(f);
      groups.set(dir, arr);
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([directory, files]) => ({ directory, files }));
  });

  readonly hasFiles = computed(() => {
    const phase = this.filesPhase();
    return phase.kind === 'ready' && phase.files.length > 0;
  });

  constructor() {
    effect(() => {
      const p = this.project();
      if (p) {
        void this.loadTestFiles();
      }
    });

    // Activate the env so it persists across navigation.
    effect(() => {
      const env = this.activeEnv();
      if (env) {
        this.envs.selectEnvironment(env.id);
      }
    });

    // Check whether Claude CLI is reachable so we can show the right UI.
    void this.tauri.chatAvailable().then((ok) => this.chatAvailable.set(ok));

    // Detect project type once per project so we can pass it as context.
    effect(() => {
      const p = this.project();
      if (!p || !this.tauri.isTauri) return;
      void this.tauri
        .detectProjectType(p.localPath)
        .then((info) => this.projectInfo.set(info))
        .catch(() => this.projectInfo.set(null));
    });

    // Auto-scroll on new messages or sending state.
    effect(() => {
      this.messages();
      this.isSending();
      this.shouldScrollToBottom = true;
    });
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom && this.messagesEnd) {
      this.messagesEnd.nativeElement.scrollIntoView({ block: 'end' });
      this.shouldScrollToBottom = false;
    }
  }

  private async loadTestFiles(): Promise<void> {
    const p = this.project();
    if (!p) return;
    if (!this.tauri.isTauri) {
      this.filesPhase.set({ kind: 'ready', files: [] });
      return;
    }
    this.filesPhase.set({ kind: 'loading' });
    try {
      const files = await this.tauri.listTestFiles(p.localPath);
      this.filesPhase.set({ kind: 'ready', files });
    } catch (err) {
      this.filesPhase.set({
        kind: 'error',
        message: this.formatError(err),
      });
    }
  }

  async selectFile(file: TestFile): Promise<void> {
    this.selectedFile.set(file);
    this.selectedFileContent.set(null);
    const p = this.project();
    if (!p) return;
    try {
      const content = await this.tauri.readTestFile(p.localPath, file.path);
      this.selectedFileContent.set(content);
    } catch (err) {
      this.selectedFileContent.set(null);
      this.notify.error(`Could not open test: ${this.formatError(err)}`);
    }
  }

  closeFilePreview(): void {
    this.selectedFile.set(null);
    this.selectedFileContent.set(null);
  }

  async sendMessage(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.isSending()) return;
    const p = this.project();
    if (!p) return;

    if (!this.chatAvailable()) {
      this.notify.error('Claude CLI not found. Install Claude Code first.');
      return;
    }

    const projectId = this.id();
    const envId = this.envId();
    const history = this.messages();

    this.chat.append(projectId, envId, { role: 'user', content: text });
    this.draft.set('');
    this.isSending.set(true);

    try {
      const env = this.activeEnv();
      const info = this.projectInfo();
      const envContext: ChatEnvContext | null = env
        ? {
            name: env.name,
            deployedUrl: env.deployedUrl,
            codeBranch: env.codeBranch,
            worktreePath: env.worktreePath ?? null,
            projectType: info?.kind ?? null,
            framework: info?.framework ?? null,
          }
        : null;
      const reply = await this.tauri.chatSend(
        p.localPath,
        envContext,
        history,
        text,
      );
      this.chat.append(projectId, envId, {
        role: 'assistant',
        content: reply,
      });
      // Claude may have created/edited test files. Refresh the list.
      void this.loadTestFiles();
    } catch (err) {
      this.notify.error(this.formatError(err));
      this.chat.append(projectId, envId, {
        role: 'assistant',
        content: `(error) ${this.formatError(err)}`,
      });
    } finally {
      this.isSending.set(false);
      // Refocus input so user can type the next message immediately.
      queueMicrotask(() => this.chatInput?.nativeElement.focus());
    }
  }

  onChatKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.sendMessage();
    }
  }

  clearChat(): void {
    this.chat.clear(this.id(), this.envId());
  }

  toggleEnvMenu(): void {
    this.isEnvMenuOpen.update((v) => !v);
  }

  switchEnv(env: Environment): void {
    this.isEnvMenuOpen.set(false);
    if (env.id === this.envId()) return;
    void this.router.navigate([
      '/projects',
      this.id(),
      'env',
      env.id,
      'workspace',
    ]);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isEnvMenuOpen()) return;
    const target = event.target as Node;
    if (this.envMenu && !this.envMenu.nativeElement.contains(target)) {
      this.isEnvMenuOpen.set(false);
    }
  }

  startResize(side: 'left' | 'right', event: MouseEvent): void {
    event.preventDefault();
    this.draggingDivider.set(side);
    this.dragStartX = event.clientX;
    this.dragStartWidth = side === 'left' ? this.leftWidth() : this.rightWidth();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    const side = this.draggingDivider();
    if (!side) return;
    const dx = event.clientX - this.dragStartX;
    if (side === 'left') {
      const next = this.clamp(this.dragStartWidth + dx, 200, 480);
      this.leftWidth.set(next);
    } else {
      const next = this.clamp(this.dragStartWidth - dx, 240, 720);
      this.rightWidth.set(next);
    }
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    if (!this.draggingDivider()) return;
    // Persist on release so we don't thrash localStorage during drag.
    localStorage.setItem('qa-tester:workspace-left-width', String(this.leftWidth()));
    localStorage.setItem('qa-tester:workspace-right-width', String(this.rightWidth()));
    this.draggingDivider.set(null);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }

  private loadWidth(key: string, fallback: number, min: number, max: number): number {
    const raw = localStorage.getItem(key);
    const n = raw ? parseInt(raw, 10) : NaN;
    if (Number.isNaN(n)) return fallback;
    return this.clamp(n, min, max);
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
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

  goBack(): void {
    void this.router.navigate(['/projects', this.id()]);
  }

  retryLoad(): void {
    void this.loadTestFiles();
  }

  private formatError(err: unknown): string {
    const msg = typeof err === 'string' ? err : (err as Error)?.message ?? 'Operation failed';
    return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
  }
}
