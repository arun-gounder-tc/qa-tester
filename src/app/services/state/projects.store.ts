import { Injectable, computed, inject, signal } from '@angular/core';
import { Project, ProjectStatus } from '../../models/project.model';
import { TauriBridgeService } from '../api/tauri-bridge.service';

const STORAGE_KEY = 'qa-tester:projects';

@Injectable({ providedIn: 'root' })
export class ProjectsStore {
  private tauri = inject(TauriBridgeService);

  private _projects = signal<Project[]>(this.load());
  private _activeProjectId = signal<string | null>(null);
  private _isLoading = signal(false);

  readonly projects = this._projects.asReadonly();
  readonly activeProjectId = this._activeProjectId.asReadonly();
  readonly isLoading = this._isLoading.asReadonly();

  readonly hasProjects = computed(() => this._projects().length > 0);
  readonly activeProject = computed(() => {
    const id = this._activeProjectId();
    return id ? this._projects().find((p) => p.id === id) ?? null : null;
  });

  setProjects(projects: Project[]): void {
    this._projects.set(projects);
    this.persist();
  }

  addProject(project: Project): void {
    this._projects.update((list) => [...list, { ...project, status: 'unchecked' }]);
    this.persist();
    void this.refreshStatus(project.id);
  }

  removeProject(id: string): void {
    this._projects.update((list) => list.filter((p) => p.id !== id));
    if (this._activeProjectId() === id) {
      this._activeProjectId.set(null);
    }
    this.persist();
  }

  selectProject(id: string): void {
    this._activeProjectId.set(id);
  }

  setLoading(loading: boolean): void {
    this._isLoading.set(loading);
  }

  async refreshAllStatus(): Promise<void> {
    if (!this.tauri.isTauri) return;
    const current = this._projects();
    await Promise.all(current.map((p) => this.refreshStatus(p.id)));
  }

  async refreshStatus(projectId: string): Promise<void> {
    if (!this.tauri.isTauri) return;
    const project = this._projects().find((p) => p.id === projectId);
    if (!project) return;

    try {
      const status = await this.tauri.checkLocalRepo(project.localPath);
      const next: ProjectStatus = !status.exists
        ? 'missing'
        : !status.is_git_repo
        ? 'not-git'
        : 'available';
      this.updateStatus(projectId, next);
    } catch {
      this.updateStatus(projectId, 'missing');
    }
  }

  private updateStatus(id: string, status: ProjectStatus): void {
    this._projects.update((list) =>
      list.map((p) => (p.id === id ? { ...p, status } : p)),
    );
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._projects()));
    } catch {
      // Storage full / unavailable — skip silently
    }
  }

  private load(): Project[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Project[];
      return Array.isArray(parsed)
        ? parsed.map((p) => ({ ...p, status: 'unchecked' as ProjectStatus }))
        : [];
    } catch {
      return [];
    }
  }
}
