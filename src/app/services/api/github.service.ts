import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface GithubUser {
  login: string;
  name: string | null;
  avatar_url: string;
  id: number;
}

export interface GithubOwner {
  login: string;
  avatar_url: string;
  type: 'User' | 'Organization';
}

export interface GithubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  clone_url: string;
  ssh_url: string;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  pushed_at: string;
  owner: GithubOwner;
}

export interface GithubBranch {
  name: string;
  protected: boolean;
}

@Injectable({ providedIn: 'root' })
export class GithubService {
  private http = inject(HttpClient);
  private readonly baseUrl = 'https://api.github.com';

  private buildHeaders(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  fetchUser(token: string): Promise<GithubUser> {
    return firstValueFrom(
      this.http.get<GithubUser>(`${this.baseUrl}/user`, {
        headers: this.buildHeaders(token),
      }),
    );
  }

  async listAllAccessibleRepos(token: string): Promise<GithubRepo[]> {
    const all: GithubRepo[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const batch = await firstValueFrom(
        this.http.get<GithubRepo[]>(
          `${this.baseUrl}/user/repos?affiliation=owner,collaborator,organization_member&per_page=${perPage}&page=${page}&sort=pushed`,
          { headers: this.buildHeaders(token) },
        ),
      );
      all.push(...batch);
      if (batch.length < perPage) break;
      page++;
      if (page > 10) break;
    }
    return all;
  }

  async listBranches(
    token: string,
    owner: string,
    repo: string,
  ): Promise<GithubBranch[]> {
    const all: GithubBranch[] = [];
    let page = 1;
    const perPage = 100;
    while (true) {
      const batch = await firstValueFrom(
        this.http.get<GithubBranch[]>(
          `${this.baseUrl}/repos/${owner}/${repo}/branches?per_page=${perPage}&page=${page}`,
          { headers: this.buildHeaders(token) },
        ),
      );
      all.push(...batch);
      if (batch.length < perPage) break;
      page++;
      if (page > 20) break;
    }
    return all;
  }
}
