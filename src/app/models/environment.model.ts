export type EnvColor = 'dev' | 'uat' | 'staging' | 'prod';

export interface Environment {
  id: string;
  name: string;
  deployedUrl: string;
  codeBranch: string;
  color: EnvColor;
  frontendPath?: string;
  worktreePath?: string;
  lastSyncedAt?: string;
}
