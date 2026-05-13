export interface RunArtifact {
  type: 'video' | 'screenshot';
  path: string;
  testCaseId?: string;
}

export interface RunResult {
  runId: string;
  environmentId: string;
  startedAt: string;
  completedAt?: string;
  totalTests: number;
  passed: number;
  failed: number;
  pending: number;
  artifacts: RunArtifact[];
}
