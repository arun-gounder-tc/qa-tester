export type ProjectStatus = 'unchecked' | 'available' | 'missing' | 'not-git';

export interface Project {
  id: string;
  name: string;
  localPath: string;
  remoteUrl: string;
  testsBranch: string;
  lastOpened?: string;
  status?: ProjectStatus;
}
