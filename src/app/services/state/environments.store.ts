import { Injectable, computed, signal } from '@angular/core';
import { Environment } from '../../models/environment.model';

const STORAGE_KEY = 'qa-tester:environments';
const ACTIVE_KEY = 'qa-tester:active-env';

type EnvMap = Record<string, Environment[]>;

@Injectable({ providedIn: 'root' })
export class EnvironmentsStore {
  private _envsByProject = signal<EnvMap>(this.load());
  private _activeEnvId = signal<string | null>(localStorage.getItem(ACTIVE_KEY));

  readonly envsByProject = this._envsByProject.asReadonly();
  readonly activeEnvId = this._activeEnvId.asReadonly();

  environmentsFor(projectId: string) {
    return computed(() => this._envsByProject()[projectId] ?? []);
  }

  hasEnvironmentsFor(projectId: string) {
    return computed(() => (this._envsByProject()[projectId]?.length ?? 0) > 0);
  }

  addEnvironment(projectId: string, env: Environment): void {
    this._envsByProject.update((map) => ({
      ...map,
      [projectId]: [...(map[projectId] ?? []), env],
    }));
    this.persist();
  }

  updateEnvironment(
    projectId: string,
    envId: string,
    patch: Partial<Environment>,
  ): void {
    this._envsByProject.update((map) => ({
      ...map,
      [projectId]: (map[projectId] ?? []).map((e) =>
        e.id === envId ? { ...e, ...patch } : e,
      ),
    }));
    this.persist();
  }

  removeEnvironment(projectId: string, envId: string): void {
    this._envsByProject.update((map) => ({
      ...map,
      [projectId]: (map[projectId] ?? []).filter((e) => e.id !== envId),
    }));
    if (this._activeEnvId() === envId) {
      this.selectEnvironment(null);
    }
    this.persist();
  }

  removeAllForProject(projectId: string): void {
    this._envsByProject.update((map) => {
      const next = { ...map };
      delete next[projectId];
      return next;
    });
    this.persist();
  }

  selectEnvironment(id: string | null): void {
    this._activeEnvId.set(id);
    if (id) {
      localStorage.setItem(ACTIVE_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._envsByProject()));
    } catch {
      // ignore quota errors silently
    }
  }

  private load(): EnvMap {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as EnvMap) : {};
    } catch {
      return {};
    }
  }
}
