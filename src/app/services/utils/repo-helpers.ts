export interface ParsedRepo {
  owner: string;
  repo: string;
}

export function parseGithubUrl(url: string): ParsedRepo | null {
  if (!url) return null;
  const trimmed = url.trim().replace(/\.git$/, '');

  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}
