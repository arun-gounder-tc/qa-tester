import { Injectable, computed, signal } from '@angular/core';
import { ChatMessage } from '../api/tauri-bridge.service';

const STORAGE_KEY = 'qa-tester:chats';
const SESSION_KEY = 'qa-tester:chat-sessions';
const MAX_MESSAGES_PER_THREAD = 100;

type ChatMap = Record<string, ChatMessage[]>;
type SessionMap = Record<string, string>;

function threadKey(projectId: string, envId: string): string {
  return `${projectId}::${envId}`;
}

@Injectable({ providedIn: 'root' })
export class ChatStore {
  private _threads = signal<ChatMap>(this.load());
  // Claude CLI session id per thread — lets each turn `--resume` the same
  // session so context stays warm and replies come back fast.
  private _sessions = signal<SessionMap>(this.loadSessions());

  readonly threads = this._threads.asReadonly();

  messagesFor(projectId: string, envId: string) {
    const key = threadKey(projectId, envId);
    return computed(() => this._threads()[key] ?? []);
  }

  sessionFor(projectId: string, envId: string): string | null {
    return this._sessions()[threadKey(projectId, envId)] ?? null;
  }

  setSession(projectId: string, envId: string, sessionId: string | null): void {
    const key = threadKey(projectId, envId);
    this._sessions.update((map) => {
      const next = { ...map };
      if (sessionId) {
        next[key] = sessionId;
      } else {
        delete next[key];
      }
      return next;
    });
    this.persistSessions();
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
    // Drop the Claude session too — a cleared chat starts fresh context.
    this.setSession(projectId, envId, null);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._threads()));
    } catch {
      // ignore quota errors
    }
  }

  private persistSessions(): void {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(this._sessions()));
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

  private loadSessions(): SessionMap {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as SessionMap) : {};
    } catch {
      return {};
    }
  }
}
