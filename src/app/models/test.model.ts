export type TestStatus = 'pending' | 'running' | 'passed' | 'failed';

export interface TestCase {
  id: string;
  name: string;
  status: TestStatus;
  durationMs?: number;
  errorMessage?: string;
}

export interface TestFile {
  id: string;
  fileName: string;
  feature: string;
  filePath: string;
  cases: TestCase[];
}

export interface TestFolder {
  name: string;
  files: TestFile[];
}
