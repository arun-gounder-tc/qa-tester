import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { homeDir } from '@tauri-apps/api/path';
import { open as openUrl } from '@tauri-apps/plugin-shell';

export interface RepoStatus {
  exists: boolean;
  is_git_repo: boolean;
  remote_url: string | null;
}

export type TestsBranchStatus =
  | 'ready'
  | 'remote-only'
  | 'missing'
  | 'needs-scaffold'
  | 'needs-update';

export interface TestsBranchInfo {
  status: TestsBranchStatus;
  current_branch: string | null;
}

export interface WorktreeInfo {
  env_id: string;
  path: string;
  branch: string;
}

export interface WorktreeListEntry {
  path: string;
  branch: string | null;
}

export type ProjectTypeKind = 'frontend' | 'backend' | 'fullstack' | 'unknown';

export interface ProjectTypeInfo {
  kind: ProjectTypeKind;
  framework: string | null;
}

export interface EnvConfigEntry {
  id: string;
  name: string;
  deployedUrl: string;
  codeBranch: string;
  color: string;
}

export interface EnvConfigFile {
  version: number;
  environments: EnvConfigEntry[];
}

export interface EnvSyncResult {
  config: EnvConfigFile;
  synced_at: string;
}

export interface TestCase {
  kind: 'suite' | 'test';
  title: string;
  depth: number;
  line: number;
}

export interface TestFile {
  path: string;
  name: string;
  relative_path: string;
  directory: string;
  size_bytes: number;
  test_cases: TestCase[];
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatEnvContext {
  name: string;
  deployedUrl: string;
  codeBranch: string;
  worktreePath: string | null;
  projectType?: string | null;
  framework?: string | null;
}

export interface ChatResult {
  reply: string;
  session_id: string | null;
}

export interface ChatProgress {
  request_id: string;
  status: string;
}

export interface CypressStatus {
  installed: boolean;
  node_modules_exists: boolean;
}

export interface LocalArtifactsInfo {
  has_screenshots: boolean;
  has_videos: boolean;
  has_downloads: boolean;
}

export interface CypressChunk {
  run_id: string;
  line: string;
  stream: 'stdout' | 'stderr';
}

export interface CypressDone {
  run_id: string;
  success: boolean;
  code: number | null;
  error: string | null;
  log_path: string | null;
  artifacts_dir: string | null;
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type PollResult =
  | { status: 'authorized'; access_token: string }
  | { status: 'pending' }
  | { status: 'slow-down' }
  | { status: 'expired' }
  | { status: 'denied' };

@Injectable({ providedIn: 'root' })
export class TauriBridgeService {
  get isTauri(): boolean {
    return typeof (window as any).__TAURI_INTERNALS__ !== 'undefined';
  }

  // Git operations
  checkLocalRepo(path: string): Promise<RepoStatus> {
    this.assertTauri('check_local_repo');
    return invoke<RepoStatus>('check_local_repo', { path });
  }

  cloneRepo(url: string, targetPath: string, token?: string): Promise<void> {
    this.assertTauri('clone_repo');
    return invoke<void>('clone_repo', { url, targetPath, token: token ?? null });
  }

  isGitInstalled(): Promise<boolean> {
    this.assertTauri('check_git_installed');
    return invoke<boolean>('check_git_installed');
  }

  // Tests branch lifecycle
  checkTestsBranch(repoPath: string, token?: string): Promise<TestsBranchInfo> {
    this.assertTauri('check_tests_branch');
    return invoke<TestsBranchInfo>('check_tests_branch', {
      repoPath,
      token: token ?? null,
    });
  }

  checkoutTestsBranch(repoPath: string, token?: string): Promise<void> {
    this.assertTauri('checkout_tests_branch');
    return invoke<void>('checkout_tests_branch', {
      repoPath,
      token: token ?? null,
    });
  }

  bootstrapTestsBranch(repoPath: string, token?: string): Promise<void> {
    this.assertTauri('bootstrap_tests_branch');
    return invoke<void>('bootstrap_tests_branch', {
      repoPath,
      token: token ?? null,
    });
  }

  updateScaffold(repoPath: string, token?: string): Promise<void> {
    this.assertTauri('update_scaffold');
    return invoke<void>('update_scaffold', {
      repoPath,
      token: token ?? null,
    });
  }

  testsStatus(repoPath: string): Promise<string[]> {
    this.assertTauri('tests_status');
    return invoke<string[]>('tests_status', { repoPath });
  }

  commitAndPushTests(
    repoPath: string,
    message: string,
    token?: string,
  ): Promise<void> {
    this.assertTauri('commit_and_push_tests');
    return invoke<void>('commit_and_push_tests', {
      repoPath,
      message,
      token: token ?? null,
    });
  }

  // Worktrees + project detection
  createEnvWorktree(
    repoPath: string,
    envId: string,
    envName: string,
    branch: string,
    token?: string,
  ): Promise<WorktreeInfo> {
    this.assertTauri('create_env_worktree');
    return invoke<WorktreeInfo>('create_env_worktree', {
      repoPath,
      envId,
      envName,
      branch,
      token: token ?? null,
    });
  }

  removeEnvWorktree(repoPath: string, worktreePath: string): Promise<void> {
    this.assertTauri('remove_env_worktree');
    return invoke<void>('remove_env_worktree', { repoPath, worktreePath });
  }

  listWorktrees(repoPath: string): Promise<WorktreeListEntry[]> {
    this.assertTauri('list_worktrees');
    return invoke<WorktreeListEntry[]>('list_worktrees', { repoPath });
  }

  detectProjectType(repoPath: string): Promise<ProjectTypeInfo> {
    this.assertTauri('detect_project_type');
    return invoke<ProjectTypeInfo>('detect_project_type', { repoPath });
  }

  revealInFinder(path: string): Promise<void> {
    this.assertTauri('reveal_in_folder');
    return invoke<void>('reveal_in_folder', { path });
  }

  async getHomeDir(): Promise<string> {
    return await homeDir();
  }

  // Env config sync (tests branch)
  readEnvConfig(repoPath: string, token?: string): Promise<EnvSyncResult> {
    this.assertTauri('read_env_config');
    return invoke<EnvSyncResult>('read_env_config', {
      repoPath,
      token: token ?? null,
    });
  }

  writeEnvConfig(
    repoPath: string,
    environments: EnvConfigEntry[],
    token?: string,
  ): Promise<EnvSyncResult> {
    this.assertTauri('write_env_config');
    return invoke<EnvSyncResult>('write_env_config', {
      repoPath,
      environments,
      token: token ?? null,
    });
  }

  // Tests files
  listTestFiles(repoPath: string): Promise<TestFile[]> {
    this.assertTauri('list_test_files');
    return invoke<TestFile[]>('list_test_files', { repoPath });
  }

  readTestFile(repoPath: string, filePath: string): Promise<string> {
    this.assertTauri('read_test_file');
    return invoke<string>('read_test_file', { repoPath, filePath });
  }

  // Chat (Claude CLI)
  chatAvailable(): Promise<boolean> {
    if (!this.isTauri) return Promise.resolve(false);
    return invoke<boolean>('chat_available');
  }

  chatSend(
    requestId: string,
    repoPath: string,
    envContext: ChatEnvContext | null,
    history: ChatMessage[],
    message: string,
    sessionId: string | null,
  ): Promise<ChatResult> {
    this.assertTauri('chat_send');
    return invoke<ChatResult>('chat_send', {
      requestId,
      repoPath,
      envContext,
      history,
      message,
      sessionId,
    });
  }

  /// Cancels an in-flight chat turn. The corresponding `chatSend` promise
  /// rejects with the cancel sentinel error string so the caller can show
  /// a graceful "stopped" state instead of an error toast.
  chatCancel(requestId: string): Promise<void> {
    this.assertTauri('chat_cancel');
    return invoke<void>('chat_cancel', { requestId });
  }

  // Cypress
  cypressCheck(repoPath: string): Promise<CypressStatus> {
    this.assertTauri('cypress_check');
    return invoke<CypressStatus>('cypress_check', { repoPath });
  }

  cypressInstall(repoPath: string, runId: string): Promise<void> {
    this.assertTauri('cypress_install');
    return invoke<void>('cypress_install', { repoPath, runId });
  }

  checkLocalArtifacts(repoPath: string): Promise<LocalArtifactsInfo> {
    this.assertTauri('check_local_artifacts');
    return invoke<LocalArtifactsInfo>('check_local_artifacts', { repoPath });
  }

  cleanLocalArtifacts(repoPath: string): Promise<void> {
    this.assertTauri('clean_local_artifacts');
    return invoke<void>('clean_local_artifacts', { repoPath });
  }

  cypressRun(
    repoPath: string,
    runId: string,
    baseUrl: string,
    spec: string | null,
    headed: boolean = false,
    artifactsDir: string | null = null,
  ): Promise<void> {
    this.assertTauri('cypress_run');
    return invoke<void>('cypress_run', {
      repoPath,
      runId,
      baseUrl,
      spec,
      headed,
      artifactsDir,
    });
  }

  // OAuth Device Flow
  startDeviceFlow(): Promise<DeviceCode> {
    this.assertTauri('start_device_flow');
    return invoke<DeviceCode>('start_device_flow');
  }

  pollForToken(deviceCode: string): Promise<PollResult> {
    this.assertTauri('poll_for_token');
    return invoke<PollResult>('poll_for_token', { deviceCode });
  }

  // External browser
  openExternal(url: string): Promise<void> {
    if (!this.isTauri) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return Promise.resolve();
    }
    return openUrl(url);
  }

  // Events
  listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
    if (!this.isTauri) return Promise.resolve(() => undefined);
    return listen<T>(event, (e) => handler(e.payload));
  }

  private assertTauri(command: string): void {
    if (!this.isTauri) {
      throw new Error(`Desktop app required for "${command}". Run: npm run tauri:dev`);
    }
  }
}
