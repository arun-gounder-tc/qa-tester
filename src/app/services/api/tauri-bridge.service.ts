import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
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

  // Worktrees + project detection
  createEnvWorktree(
    repoPath: string,
    envId: string,
    branch: string,
    token?: string,
  ): Promise<WorktreeInfo> {
    this.assertTauri('create_env_worktree');
    return invoke<WorktreeInfo>('create_env_worktree', {
      repoPath,
      envId,
      branch,
      token: token ?? null,
    });
  }

  removeEnvWorktree(repoPath: string, envId: string): Promise<void> {
    this.assertTauri('remove_env_worktree');
    return invoke<void>('remove_env_worktree', { repoPath, envId });
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
    return this.openExternal(path);
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
