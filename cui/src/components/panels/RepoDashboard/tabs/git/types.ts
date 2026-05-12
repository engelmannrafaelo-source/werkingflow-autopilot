export interface GitRepo {
  path: string;
  name: string;
  branch: string;
  uncommitted: number;
  dirty: boolean;
  head: { hash: string; author: string; message: string; date: string } | null;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  message: string;
}

export interface GitBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  date: string;
  headHash: string;
  headMsg: string;
  isCurrent: boolean;
}

export interface GitFile {
  path: string;
  x: string;
  y: string;
  kind: 'staged' | 'unstaged' | 'untracked' | 'conflicted' | 'mixed';
}

export interface GitStatusResponse {
  files: GitFile[];
  summary: { staged: number; unstaged: number; untracked: number; conflicted: number };
}
