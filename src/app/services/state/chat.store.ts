import { Injectable, computed, signal } from '@angular/core';
import { ChatMessage } from '../api/tauri-bridge.service';

const STORAGE_KEY = 'qa-tester:chats';
const MAX_MESSAGES_PER_THREAD = 100;

type ChatMap = Record<string, ChatMessage[]>;

function threadKey(projectId: string, envId: string): string {
  return `${projectId}::${envId}`;
}

@Injectable({ providedIn: 'root' })
export class ChatStore {
  private _threads = signal<ChatMap>(this.load());

  readonly threads = this._threads.asReadonly();

  messagesFor(projectId: string, envId: string) {
    const key = threadKey(projectId, envId);
    return computed(() => this._threads()[key] ?? []);
  }

  append(projectId: string, envId: string, message: ChatMessage): void {
    const key = threadKey(projectId, envId);
    this._threads.update((map) => {
      const existing = map[key] ?? [];
      const next = [...existing, message];
      const trimmed =
        next.length > MAX_MESSAGES_PER_THREAD
          ? next.slice(next.length - MAX_MESSAGES_PER_THREAD)
          : next;
      return { ...map, [key]: trimmed };
    });
    this.persist();
  }

  clear(projectId: string, envId: string): void {
    const key = threadKey(projectId, envId);
    this._threads.update((map) => {
      const next = { ...map };
      delete next[key];
      return next;
    });
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._threads()));
    } catch {
      // ignore quota errors
    }
  }

  private load(): ChatMap {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as ChatMap) : {};
    } catch {
      return {};
    }
  }
}
