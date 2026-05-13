import { Injectable, computed, signal } from '@angular/core';

export interface AuthUser {
  login: string;
  name: string;
  avatarUrl: string;
}

const TOKEN_KEY = 'qa-tester:gh-token';
const USER_KEY = 'qa-tester:gh-user';

@Injectable({ providedIn: 'root' })
export class AuthStore {
  private _user = signal<AuthUser | null>(this.loadUser());
  private _token = signal<string | null>(localStorage.getItem(TOKEN_KEY));

  readonly user = this._user.asReadonly();
  readonly token = this._token.asReadonly();
  readonly isAuthenticated = computed(() => this._token() !== null);

  setSession(user: AuthUser, token: string): void {
    this._user.set(user);
    this._token.set(token);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  clear(): void {
    this._user.set(null);
    this._token.set(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  private loadUser(): AuthUser | null {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? (JSON.parse(raw) as AuthUser) : null;
    } catch {
      return null;
    }
  }
}
