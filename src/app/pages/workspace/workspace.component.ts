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
  OnDestroy,
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
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FileCode2,
  Folder,
  FolderOpen,
  LoaderCircle,
  LogIn,
  LogOut,
  LucideAngularModule,
  MessageSquare,
  Paperclip,
  Play,
  Plus,
  X,
  Search,
  Send,
  Square,
  Terminal,
  TestTube2,
  Trash2,
  XCircle,
} from 'lucide-angular';
import { ClaudeLogoComponent } from '../../components/shared/claude-logo/claude-logo.component';
import { UserMenuComponent } from '../../components/shared/user-menu/user-menu.component';
import { Environment } from '../../models/environment.model';
import {
  AuthStatus,
  ChatEnvContext,
  ChatProgress,
  CypressChunk,
  CypressDone,
  LoginLine,
  ProjectTypeInfo,
  TauriBridgeService,
  TestFile,
} from '../../services/api/tauri-bridge.service';
import { AuthStore } from '../../services/state/auth.store';
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

type RunStatus = 'running' | 'passed' | 'failed';
type TestStatus = 'idle' | 'running' | 'passed' | 'failed';

interface ActiveRun {
  runId: string;
  kind: 'test' | 'all' | 'install';
  specPath: string | null;
  title: string;
  output: string[];
  status: RunStatus;
  artifactsDir: string | null;
  startedAt: number;
}

interface RunResult {
  status: 'passed' | 'failed';
  kind: 'test' | 'all' | 'install';
  title: string;
  artifactsDir: string | null;
  durationMs: number;
}

interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  // Absolute path on disk where the file was saved. Claude reads it directly
  // via its Read tool, so the file lives inside the repo's .qa-tester/
  // attachments dir and is covered by Claude's workspace permissions.
  path: string;
}

// 25 MB cap — Tauri's JSON IPC is slow for huge byte arrays; bigger than
// this and we'd want a streaming approach.
const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

@Component({
  selector: 'app-workspace',
  standalone: true,
  imports: [ClaudeLogoComponent, FormsModule, LucideAngularModule, UserMenuComponent],
  templateUrl: './workspace.component.html',
  styleUrl: './workspace.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkspaceComponent implements AfterViewChecked, OnDestroy {
  private projects = inject(ProjectsStore);
  private envs = inject(EnvironmentsStore);
  private chat = inject(ChatStore);
  private auth = inject(AuthStore);
  private tauri = inject(TauriBridgeService);
  private notify = inject(NotificationService);
  private router = inject(Router);
  private sanitizer = inject(DomSanitizer);

  readonly LogoIcon = TestTube2;
  readonly BackIcon = ArrowLeft;
  readonly LoaderIcon = LoaderCircle;
  readonly ChevronDownIcon = ChevronDown;
  readonly ChevronRightIcon = ChevronRight;
  readonly FolderIcon = Folder;
  readonly FolderOpenIcon = FolderOpen;
  readonly FileIcon = FileCode2;
  readonly PlusIcon = Plus;
  readonly ChatIcon = MessageSquare;
  readonly SearchIcon = Search;
  readonly SendIcon = Send;
  readonly StopIcon = Square;
  readonly PaperclipIcon = Paperclip;
  readonly CloseIcon = X;
  readonly LoginIcon = LogIn;
  readonly LogoutIcon = LogOut;
  readonly TrashIcon = Trash2;
  readonly PlayIcon = Play;
  readonly TerminalIcon = Terminal;
  readonly CheckIcon = CheckCircle2;
  readonly XIcon = XCircle;
  readonly ChevronUpIcon = ChevronUp;
  readonly WarnIcon = AlertTriangle;

  id = input.required<string>();
  envId = input.required<string>();

  @ViewChild('envMenu') envMenu?: ElementRef<HTMLElement>;
  @ViewChild('messagesEnd') messagesEnd?: ElementRef<HTMLElement>;
  @ViewChild('chatInput') chatInput?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('outputBox') outputBox?: ElementRef<HTMLElement>;
  @ViewChild('fileInput') fileInput?: ElementRef<HTMLInputElement>;

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
  // Paths of test files whose describe/it tree is expanded in the sidebar.
  readonly expandedFiles = signal<Set<string>>(new Set());

  readonly chatAvailable = signal<boolean | null>(null);
  readonly authStatus = signal<AuthStatus | null>(null);
  readonly authChecking = signal(false);

  readonly authLoggedIn = computed(() => this.authStatus()?.logged_in === true);
  readonly authCliMissing = computed(() => this.authStatus()?.cli_missing === true);
  readonly authReady = computed(() => this.authStatus() !== null);

  readonly isLoggingIn = signal(false);
  readonly loginStatusLines = signal<string[]>([]);
  readonly loginError = signal<string | null>(null);
  private loginRequestId: string | null = null;
  private loginUnsub: (() => void) | null = null;

  readonly projectInfo = signal<ProjectTypeInfo | null>(null);
  readonly isSending = signal(false);
  // Live status of the in-flight Claude turn ("Reading login.cy.js", …).
  readonly chatStatus = signal('');
  // Request id of the in-flight chat turn — used by the Stop button +
  // Escape-key handler to cancel via `chat_cancel`.
  readonly currentRequestId = signal<string | null>(null);
  readonly draft = signal('');
  readonly attachments = signal<ChatAttachment[]>([]);
  // True while the user is dragging files over the chat panel — drives the
  // overlay visibility.
  readonly isDraggingOver = signal(false);
  private dragDepth = 0;

  // Resizable panel widths (in px). Persisted to localStorage.
  readonly leftWidth = signal(this.loadWidth('qa-tester:workspace-left-width', 288, 200, 480));
  readonly rightWidth = signal(this.loadWidth('qa-tester:workspace-right-width', 360, 240, 720));
  readonly draggingDivider = signal<'left' | 'right' | null>(null);
  private dragStartX = 0;
  private dragStartWidth = 0;

  // Cypress runner state
  readonly cypressInstalled = signal<boolean | null>(null);
  readonly activeRun = signal<ActiveRun | null>(null);
  readonly testStatuses = signal<Record<string, TestStatus>>({});
  readonly outputPanelOpen = signal(false);
  readonly outputPanelHeight = signal(
    this.loadWidth('qa-tester:workspace-output-height', 280, 140, 720),
  );
  readonly draggingOutput = signal(false);
  private outputDragStartY = 0;
  private outputDragStartHeight = 0;

  readonly headedMode = signal(localStorage.getItem('qa-tester:headed') === '1');

  readonly isRunBusy = computed(() => this.activeRun()?.status === 'running');
  readonly lastResult = signal<RunResult | null>(null);
  readonly hasOrphanArtifacts = signal(false);

  // Uncommitted tests reminder
  readonly uncommittedTests = signal<string[]>([]);
  readonly commitSnoozedUntil = signal<number>(0);
  readonly now = signal<number>(Date.now());
  readonly isCommitting = signal(false);
  readonly showCommitBanner = computed(() => {
    return (
      this.uncommittedTests().length > 0 &&
      this.now() >= this.commitSnoozedUntil()
    );
  });

  private activeUnsubs: Array<() => void> = [];
  private artifactsBaseDir: string | null = null;
  private commitPollHandle: ReturnType<typeof setInterval> | null = null;
  private nowTickHandle: ReturnType<typeof setInterval> | null = null;

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
  private shouldScrollOutputToBottom = false;

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

    // Check CLI availability + auth state in one shot so the UI can choose
    // between install prompt / login button / chat composer.
    void this.refreshAuthStatus();

    // Detect project type once per project so we can pass it as context.
    effect(() => {
      const p = this.project();
      if (!p || !this.tauri.isTauri) return;
      void this.tauri
        .detectProjectType(p.localPath)
        .then((info) => this.projectInfo.set(info))
        .catch(() => this.projectInfo.set(null));
    });

    // Check Cypress install state on project load.
    effect(() => {
      const p = this.project();
      if (!p || !this.tauri.isTauri) return;
      void this.tauri
        .cypressCheck(p.localPath)
        .then((s) => this.cypressInstalled.set(s.installed))
        .catch(() => this.cypressInstalled.set(false));
    });

    // Resolve home dir once so we can compute the artifacts base path.
    if (this.tauri.isTauri) {
      void this.tauri.getHomeDir().then((home) => {
        this.artifactsBaseDir = `${home}/Documents/QA Tester Artifacts`;
      });
    }

    // Detect orphan cypress artifacts left in the repo from earlier runs.
    effect(() => {
      const p = this.project();
      if (!p || !this.tauri.isTauri) return;
      void this.tauri
        .checkLocalArtifacts(p.localPath)
        .then((info) => {
          this.hasOrphanArtifacts.set(
            info.has_screenshots || info.has_videos || info.has_downloads,
          );
        })
        .catch(() => undefined);
    });

    // Initial uncommitted-tests check + periodic poll every 30s.
    effect(() => {
      const p = this.project();
      if (!p || !this.tauri.isTauri) return;
      void this.refreshUncommittedTests();
    });

    this.commitPollHandle = setInterval(() => {
      void this.refreshUncommittedTests();
    }, 30_000);

    // Tick clock so the snooze-until comparison re-evaluates over time.
    this.nowTickHandle = setInterval(() => {
      this.now.set(Date.now());
    }, 10_000);

    // Auto-scroll on new messages or sending state.
    effect(() => {
      this.messages();
      this.isSending();
      this.shouldScrollToBottom = true;
    });

    // Auto-scroll the output panel as new lines stream in.
    effect(() => {
      const run = this.activeRun();
      if (run) {
        run.output.length;
        this.shouldScrollOutputToBottom = true;
      }
    });
  }

  ngAfterViewChecked(): void {
    if (this.shouldScrollToBottom && this.messagesEnd) {
      this.messagesEnd.nativeElement.scrollIntoView({ block: 'end' });
      this.shouldScrollToBottom = false;
    }
    if (this.shouldScrollOutputToBottom && this.outputBox) {
      const el = this.outputBox.nativeElement;
      el.scrollTop = el.scrollHeight;
      this.shouldScrollOutputToBottom = false;
    }
  }

  ngOnDestroy(): void {
    for (const unsub of this.activeUnsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.activeUnsubs = [];
    if (this.commitPollHandle !== null) {
      clearInterval(this.commitPollHandle);
      this.commitPollHandle = null;
    }
    if (this.nowTickHandle !== null) {
      clearInterval(this.nowTickHandle);
      this.nowTickHandle = null;
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

  /// File-row click: open the preview and expand its test tree (if any).
  onFileClick(file: TestFile): void {
    void this.selectFile(file);
    if (file.test_cases.length > 0 && !this.isExpanded(file)) {
      this.toggleExpand(file);
    }
  }

  toggleExpand(file: TestFile, event?: Event): void {
    event?.stopPropagation();
    this.expandedFiles.update((set) => {
      const next = new Set(set);
      if (next.has(file.path)) {
        next.delete(file.path);
      } else {
        next.add(file.path);
      }
      return next;
    });
  }

  isExpanded(file: TestFile): boolean {
    return this.expandedFiles().has(file.path);
  }

  /// Left padding (px) for a test-case row, nested under its file + suites.
  testCaseIndent(hasDirectory: boolean, depth: number): number {
    const base = hasDirectory ? 44 : 28;
    return base + depth * 14;
  }

  async sendMessage(): Promise<void> {
    const text = this.draft().trim();
    const files = this.attachments();
    if ((!text && files.length === 0) || this.isSending()) return;
    const p = this.project();
    if (!p) return;

    if (!this.chatAvailable()) {
      this.notify.error('Claude CLI not found. Install Claude Code first.');
      return;
    }

    const projectId = this.id();
    const envId = this.envId();
    const history = this.messages();

    const displayText = this.formatMessageForDisplay(text, files);
    const promptText = text.length > 0 ? text : '(See attached files.)';
    const attachmentPaths = files.map((f) => f.path);

    this.chat.append(projectId, envId, { role: 'user', content: displayText });
    this.draft.set('');
    this.attachments.set([]);
    this.isSending.set(true);
    this.chatStatus.set('Sending…');

    const requestId = `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.currentRequestId.set(requestId);
    let unsubProgress: (() => void) | null = null;

    try {
      // Stream live progress ("Reading login.cy.js", …) into the UI so the
      // tester sees what Claude is doing instead of a frozen spinner.
      unsubProgress = await this.tauri.listen<ChatProgress>(
        `chat-progress:${requestId}`,
        (progress) => this.chatStatus.set(progress.status),
      );

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
      // Resume the existing Claude session if we have one — keeps context
      // warm so follow-up messages don't re-read the whole codebase.
      const sessionId = this.chat.sessionFor(projectId, envId);
      const result = await this.tauri.chatSend(
        requestId,
        p.localPath,
        envContext,
        history,
        promptText,
        sessionId,
        attachmentPaths,
      );
      this.chat.setSession(projectId, envId, result.session_id);
      this.chat.append(projectId, envId, {
        role: 'assistant',
        content: result.reply,
      });
      // Claude may have created/edited test files. Refresh the list AND
      // the uncommitted-changes check so the commit banner shows up.
      void this.loadTestFiles();
      void this.refreshUncommittedTests();
    } catch (err) {
      const msg = this.formatError(err);
      // Stop button / Escape — show a quiet "(stopped)" placeholder so the
      // user can see where the turn ended without an error toast.
      if (this.isCancelError(msg)) {
        this.chat.append(projectId, envId, {
          role: 'assistant',
          content: '(stopped)',
        });
      } else {
        this.notify.error(msg);
        this.chat.append(projectId, envId, {
          role: 'assistant',
          content: `(error) ${msg}`,
        });
      }
    } finally {
      if (unsubProgress) unsubProgress();
      this.isSending.set(false);
      this.chatStatus.set('');
      this.currentRequestId.set(null);
      // Refocus input so user can type the next message immediately.
      queueMicrotask(() => this.chatInput?.nativeElement.focus());
    }
  }

  /// Stops the in-flight chat turn (Stop button + Escape key). No-op if
  /// nothing is running.
  cancelChat(): void {
    const id = this.currentRequestId();
    if (!id) return;
    this.chatStatus.set('Stopping…');
    void this.tauri.chatCancel(id).catch(() => {
      // Cancel is best-effort — if it errors, the chat_send promise will
      // resolve normally and we'll just ignore the late reply.
    });
  }

  private isCancelError(message: string): boolean {
    return message.includes('__chat_cancelled__');
  }

  async refreshAuthStatus(): Promise<void> {
    this.authChecking.set(true);
    try {
      const status = await this.tauri.chatAuthStatus();
      this.authStatus.set(status);
      this.chatAvailable.set(!status.cli_missing);
    } catch {
      this.authStatus.set({
        cli_missing: true,
        logged_in: false,
        email: null,
        auth_method: null,
        subscription_type: null,
      });
      this.chatAvailable.set(false);
    } finally {
      this.authChecking.set(false);
    }
  }

  async startLogin(useConsole = false): Promise<void> {
    if (this.isLoggingIn()) return;
    if (!this.tauri.isTauri) {
      this.notify.error('Sign-in requires the desktop app.');
      return;
    }
    const requestId = `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.loginRequestId = requestId;
    this.loginStatusLines.set(['Opening your browser — complete the sign-in there.']);
    this.loginError.set(null);
    this.isLoggingIn.set(true);

    try {
      // Tee CLI output into the modal so the user sees the auth URL or any
      // prompts the CLI prints while it waits for the browser callback.
      this.loginUnsub = await this.tauri.listen<LoginLine>(
        `claude-login:${requestId}`,
        (event) => {
          this.loginStatusLines.update((lines) => [...lines, event.line]);
        },
      );

      const ok = await this.tauri.chatLoginStart(requestId, useConsole);
      if (ok) {
        this.loginStatusLines.update((lines) => [...lines, '✓ Signed in successfully']);
        await this.refreshAuthStatus();
        this.notify.success(
          this.authStatus()?.email
            ? `Signed in as ${this.authStatus()!.email}`
            : 'Signed in to Claude',
        );
      } else {
        this.loginError.set('Sign-in did not complete. Try again.');
      }
    } catch (err) {
      const msg = this.formatError(err);
      if (msg.includes('__login_cancelled__')) {
        this.loginStatusLines.update((lines) => [...lines, '(cancelled)']);
      } else {
        this.loginError.set(msg);
      }
    } finally {
      if (this.loginUnsub) this.loginUnsub();
      this.loginUnsub = null;
      this.loginRequestId = null;
      this.isLoggingIn.set(false);
    }
  }

  cancelLogin(): void {
    const id = this.loginRequestId;
    if (!id) return;
    void this.tauri.chatLoginCancel(id).catch(() => undefined);
  }

  dismissLoginError(): void {
    this.loginError.set(null);
    this.loginStatusLines.set([]);
  }

  async logout(): Promise<void> {
    try {
      await this.tauri.chatLogout();
      await this.refreshAuthStatus();
      this.notify.success('Signed out');
    } catch (err) {
      this.notify.error(this.formatError(err));
    }
  }

  openFilePicker(): void {
    if (this.isSending()) return;
    this.fileInput?.nativeElement.click();
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files && files.length > 0) {
      void this.addFiles(Array.from(files));
    }
    // Reset so the same file can be re-picked after removal.
    input.value = '';
  }

  removeAttachment(id: string): void {
    this.attachments.update((list) => list.filter((a) => a.id !== id));
  }

  onChatDragEnter(event: DragEvent): void {
    if (!this.hasFilesInDrag(event)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.isDraggingOver.set(true);
  }

  onChatDragOver(event: DragEvent): void {
    if (!this.hasFilesInDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  onChatDragLeave(event: DragEvent): void {
    if (!this.hasFilesInDrag(event)) return;
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.isDraggingOver.set(false);
    }
  }

  onChatDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragDepth = 0;
    this.isDraggingOver.set(false);
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      void this.addFiles(Array.from(files));
    }
  }

  private hasFilesInDrag(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  private async addFiles(files: File[]): Promise<void> {
    const project = this.project();
    if (!project) return;
    if (!this.tauri.isTauri) {
      this.notify.error('File attachments require the desktop app.');
      return;
    }
    const next: ChatAttachment[] = [];
    for (const file of files) {
      if (file.size > ATTACHMENT_MAX_BYTES) {
        this.notify.error(
          `${file.name} is ${this.formatBytes(file.size)} — over the 25 MB attachment limit.`,
        );
        continue;
      }
      try {
        const buffer = await file.arrayBuffer();
        const path = await this.tauri.saveAttachment(
          project.localPath,
          file.name,
          new Uint8Array(buffer),
        );
        next.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          size: file.size,
          path,
        });
      } catch (err) {
        this.notify.error(`Could not save ${file.name}: ${this.formatError(err)}`);
      }
    }
    if (next.length === 0) return;
    this.attachments.update((list) => [...list, ...next]);
  }

  private formatMessageForDisplay(text: string, files: ChatAttachment[]): string {
    if (files.length === 0) return text;
    const names = files.map((f) => `📎 ${f.name}`).join('\n');
    return text.length > 0 ? `${text}\n\n${names}` : names;
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  /// Strips the trailing `<choices>…</choices>` block from an assistant
  /// message before rendering it as plain text.
  visibleContent(content: string): string {
    return content.replace(/<choices>[\s\S]*?<\/choices>\s*$/i, '').trim();
  }

  /// Extracts choice labels from a `<choices><option>…</option></choices>`
  /// trailer. Returns an empty array when no choices are present, so the
  /// template can simply `@if (choices.length)`.
  choicesFor(content: string): string[] {
    const block = content.match(/<choices>([\s\S]*?)<\/choices>\s*$/i);
    if (!block) return [];
    const options: string[] = [];
    const optionRe = /<option>([\s\S]*?)<\/option>/gi;
    let m: RegExpExecArray | null;
    while ((m = optionRe.exec(block[1])) !== null) {
      const text = m[1].trim();
      if (text.length > 0) options.push(text);
    }
    return options;
  }

  /// True only for the LATEST assistant message — earlier choices are stale
  /// (the user already moved past them) and shouldn't show clickable buttons.
  isLatestAssistant(index: number): boolean {
    const msgs = this.messages();
    if (msgs[index].role !== 'assistant') return false;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'assistant') return i === index;
    }
    return false;
  }

  pickChoice(choice: string): void {
    if (this.isSending()) return;
    this.draft.set(choice);
    void this.sendMessage();
  }

  onChatKeydown(event: KeyboardEvent): void {
    // Escape stops an in-flight turn — same UX as Claude's terminal client.
    if (event.key === 'Escape' && this.isSending()) {
      event.preventDefault();
      this.cancelChat();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void this.sendMessage();
    }
  }

  clearChat(): void {
    this.chat.clear(this.id(), this.envId());
  }

  testStatusFor(file: TestFile): TestStatus {
    const key = `tests/e2e/${file.relative_path}`;
    return this.testStatuses()[key] ?? 'idle';
  }

  private setTestStatus(specPath: string, status: TestStatus): void {
    this.testStatuses.update((m) => ({ ...m, [specPath]: status }));
  }

  private newRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private slugify(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      || 'unnamed';
  }

  private timestampForRun(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(
      d.getHours(),
    )}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  private artifactsDirFor(envName: string): string | null {
    const project = this.project();
    if (!this.artifactsBaseDir || !project) return null;
    return `${this.artifactsBaseDir}/${this.slugify(project.name)}/${this.slugify(envName)}/${this.timestampForRun()}`;
  }

  async runTest(file: TestFile, event: Event): Promise<void> {
    event.stopPropagation();
    if (this.isRunBusy()) {
      this.notify.info('Another test is already running.');
      return;
    }
    const p = this.project();
    const env = this.activeEnv();
    if (!p || !env) return;

    if (this.cypressInstalled() === false) {
      const ok = await this.installCypress();
      if (!ok) return;
    }

    const specPath = `tests/e2e/${file.relative_path}`;
    const artifactsDir = this.artifactsDirFor(env.name);
    await this.startRun({
      kind: 'test',
      specPath,
      title: file.relative_path,
      artifactsDir,
      initialLine: `▶ Running ${file.relative_path} against ${env.deployedUrl}${this.headedMode() ? ' (headed)' : ''}`,
      spawn: (runId) =>
        this.tauri.cypressRun(
          p.localPath,
          runId,
          env.deployedUrl,
          specPath,
          this.headedMode(),
          artifactsDir,
        ),
    });
  }

  async runAll(): Promise<void> {
    if (this.isRunBusy()) {
      this.notify.info('Another run is already in progress.');
      return;
    }
    const p = this.project();
    const env = this.activeEnv();
    if (!p || !env) return;

    if (this.cypressInstalled() === false) {
      const ok = await this.installCypress();
      if (!ok) return;
    }

    // Mark all tests as running.
    const next: Record<string, TestStatus> = {};
    const phase = this.filesPhase();
    if (phase.kind === 'ready') {
      for (const f of phase.files) {
        next[`tests/e2e/${f.relative_path}`] = 'running';
      }
    }
    this.testStatuses.set(next);

    const artifactsDir = this.artifactsDirFor(env.name);
    await this.startRun({
      kind: 'all',
      specPath: null,
      title: 'All tests',
      artifactsDir,
      initialLine: `▶ Running all tests against ${env.deployedUrl}${this.headedMode() ? ' (headed)' : ''}`,
      spawn: (runId) =>
        this.tauri.cypressRun(
          p.localPath,
          runId,
          env.deployedUrl,
          null,
          this.headedMode(),
          artifactsDir,
        ),
    });
  }

  /// Returns true if Cypress is installed after this call.
  async installCypress(): Promise<boolean> {
    const p = this.project();
    if (!p) return false;
    if (this.isRunBusy()) return false;

    const done = await this.startRun({
      kind: 'install',
      specPath: null,
      title: 'Installing Cypress',
      artifactsDir: null,
      initialLine: '▶ Installing Cypress and dependencies (one-time, ~30–60s)',
      spawn: (runId) => this.tauri.cypressInstall(p.localPath, runId),
    });

    // After install completes, re-check.
    try {
      const status = await this.tauri.cypressCheck(p.localPath);
      this.cypressInstalled.set(status.installed);
      return status.installed && done;
    } catch {
      return false;
    }
  }

  /// Unified run starter — sets up active run, subscribes to events,
  /// spawns the process, and AWAITS the done event before resolving.
  /// Returns true on success.
  private async startRun(opts: {
    kind: 'test' | 'all' | 'install';
    specPath: string | null;
    title: string;
    artifactsDir: string | null;
    initialLine: string;
    spawn: (runId: string) => Promise<void>;
  }): Promise<boolean> {
    const runId = this.newRunId();
    this.activeRun.set({
      runId,
      kind: opts.kind,
      specPath: opts.specPath,
      title: opts.title,
      output: [opts.initialLine, ''],
      status: 'running',
      artifactsDir: opts.artifactsDir,
      startedAt: Date.now(),
    });
    if (opts.kind === 'test' && opts.specPath) {
      this.setTestStatus(opts.specPath, 'running');
    }
    this.outputPanelOpen.set(true);

    const donePromise = this.subscribeToRun(runId);

    try {
      await opts.spawn(runId);
    } catch (err) {
      this.handleRunError(runId, err);
      return false;
    }

    return donePromise;
  }

  /// Subscribes to streaming + done events for a run. The returned promise
  /// resolves to true on success (process exited 0) and false on failure.
  private subscribeToRun(runId: string): Promise<boolean> {
    return new Promise<boolean>(async (resolve) => {
      const unsubChunk = await this.tauri.listen<CypressChunk>(
        `cypress-output:${runId}`,
        (chunk) => {
          this.activeRun.update((r) => {
            if (!r || r.runId !== runId) return r;
            const next = [...r.output, chunk.line];
            const trimmed = next.length > 5000 ? next.slice(-5000) : next;
            return { ...r, output: trimmed };
          });
        },
      );
      const unsubDone = await this.tauri.listen<CypressDone>(
        `cypress-done:${runId}`,
        (done) => {
          const finalStatus: RunStatus = done.success ? 'passed' : 'failed';
          this.activeRun.update((r) =>
            r && r.runId === runId ? { ...r, status: finalStatus } : r,
          );
          const run = this.activeRun();
          if (run?.kind === 'test' && run.specPath) {
            this.setTestStatus(run.specPath, finalStatus);
          } else if (run?.kind === 'all') {
            const next: Record<string, TestStatus> = {};
            for (const k of Object.keys(this.testStatuses())) {
              next[k] = finalStatus;
            }
            this.testStatuses.set(next);
          }
          if (done.error) {
            this.activeRun.update((r) =>
              r && r.runId === runId
                ? { ...r, output: [...r.output, '', `Error: ${done.error}`] }
                : r,
            );
          }
          // Show post-run result modal for test runs (not install).
          if (run && run.kind !== 'install') {
            this.lastResult.set({
              status: finalStatus,
              kind: run.kind,
              title: run.title,
              artifactsDir: done.artifacts_dir ?? run.artifactsDir,
              durationMs: Date.now() - run.startedAt,
            });
            // A run can update tests/ via Cypress hooks or fixtures — recheck.
            void this.refreshUncommittedTests();
          }
          unsubChunk();
          unsubDone();
          this.activeUnsubs = this.activeUnsubs.filter(
            (fn) => fn !== unsubChunk && fn !== unsubDone,
          );
          resolve(done.success);
        },
      );
      this.activeUnsubs.push(unsubChunk, unsubDone);
    });
  }

  private handleRunError(runId: string, err: unknown): void {
    this.activeRun.update((r) =>
      r && r.runId === runId
        ? { ...r, status: 'failed', output: [...r.output, '', `Error: ${this.formatError(err)}`] }
        : r,
    );
  }

  async openArtifactsFolder(): Promise<void> {
    const target =
      this.lastResult()?.artifactsDir ??
      this.activeRun()?.artifactsDir ??
      `${this.project()?.localPath ?? ''}/cypress`;
    if (!target) return;
    try {
      await this.tauri.revealInFinder(target);
    } catch (err) {
      this.notify.error(this.formatError(err));
    }
  }

  dismissResult(): void {
    this.lastResult.set(null);
  }

  async cleanOrphanArtifacts(): Promise<void> {
    const p = this.project();
    if (!p) return;
    try {
      await this.tauri.cleanLocalArtifacts(p.localPath);
      this.hasOrphanArtifacts.set(false);
      this.notify.success('Cleaned up local Cypress artifacts');
    } catch (err) {
      this.notify.error(this.formatError(err));
    }
  }

  private async refreshUncommittedTests(): Promise<void> {
    const p = this.project();
    if (!p || !this.tauri.isTauri) return;
    try {
      const files = await this.tauri.testsStatus(p.localPath);
      this.uncommittedTests.set(files);
    } catch {
      // ignore — the banner just won't show
    }
  }

  snoozeCommitReminder(): void {
    // 10 minutes — checked against `now()` which ticks every 10s.
    this.commitSnoozedUntil.set(Date.now() + 10 * 60 * 1000);
    this.notify.info("Reminder snoozed — we'll ask again in 10 minutes.");
  }

  async commitTests(): Promise<void> {
    const p = this.project();
    if (!p) return;
    const files = this.uncommittedTests();
    if (files.length === 0) return;

    const message = `tests: update ${files.length} file${files.length === 1 ? '' : 's'}`;
    this.isCommitting.set(true);
    try {
      await this.tauri.commitAndPushTests(
        p.localPath,
        message,
        this.auth.token() ?? undefined,
      );
      this.uncommittedTests.set([]);
      this.commitSnoozedUntil.set(0);
      this.notify.success('Tests pushed to GitHub');
    } catch (err) {
      this.notify.error(this.formatError(err));
    } finally {
      this.isCommitting.set(false);
    }
  }

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 100) / 10;
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s - m * 60);
    return `${m}m ${rem}s`;
  }

  toggleHeaded(): void {
    this.headedMode.update((v) => !v);
    localStorage.setItem('qa-tester:headed', this.headedMode() ? '1' : '0');
  }

  toggleOutputPanel(): void {
    this.outputPanelOpen.update((v) => !v);
  }

  closeRun(): void {
    this.activeRun.set(null);
    this.outputPanelOpen.set(false);
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

  @HostListener('document:keydown.escape')
  onDocumentEscape(): void {
    // Global Escape — stop the in-flight chat from anywhere in the workspace.
    if (this.isSending()) {
      this.cancelChat();
    }
  }

  startResize(side: 'left' | 'right', event: MouseEvent): void {
    event.preventDefault();
    this.draggingDivider.set(side);
    this.dragStartX = event.clientX;
    this.dragStartWidth = side === 'left' ? this.leftWidth() : this.rightWidth();
  }

  startOutputResize(event: MouseEvent): void {
    event.preventDefault();
    this.draggingOutput.set(true);
    this.outputDragStartY = event.clientY;
    this.outputDragStartHeight = this.outputPanelHeight();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    const side = this.draggingDivider();
    if (side) {
      const dx = event.clientX - this.dragStartX;
      if (side === 'left') {
        const next = this.clamp(this.dragStartWidth + dx, 200, 480);
        this.leftWidth.set(next);
      } else {
        const next = this.clamp(this.dragStartWidth - dx, 240, 720);
        this.rightWidth.set(next);
      }
      return;
    }
    if (this.draggingOutput()) {
      // Drag the top edge up to grow the panel (negative dy = larger panel).
      const dy = event.clientY - this.outputDragStartY;
      const next = this.clamp(this.outputDragStartHeight - dy, 140, 720);
      this.outputPanelHeight.set(next);
    }
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    if (this.draggingDivider()) {
      localStorage.setItem('qa-tester:workspace-left-width', String(this.leftWidth()));
      localStorage.setItem('qa-tester:workspace-right-width', String(this.rightWidth()));
      this.draggingDivider.set(null);
    }
    if (this.draggingOutput()) {
      localStorage.setItem(
        'qa-tester:workspace-output-height',
        String(this.outputPanelHeight()),
      );
      this.draggingOutput.set(false);
    }
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
