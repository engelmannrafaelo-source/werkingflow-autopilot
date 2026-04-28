/**
 * git-shell — Run git commands in a per-user repo on the partner-server.
 *
 * On the partner deployment, the CUI server runs as `claude-user` and each
 * partner has their own checkout under `/home/<userId>/projekte/<repo>`.
 * To touch another user's repo, we shell out via `sudo -u <userId> -n` —
 * a sudoers rule grants claude-user passwordless access to git for the
 * partner-user accounts.
 *
 * Sudoers rule (installed by setup-app-workspaces.sh):
 *   claude-user ALL=(<userId>) NOPASSWD: /usr/bin/git
 *
 * On dev, the repos don't exist; callers MUST be in forward mode.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';

const execFileP = promisify(execFile);

export const REPO_SUBPATH = 'projekte/werkingflow-production';

export function repoPathFor(userId: string): string {
  return `/home/${userId}/${REPO_SUBPATH}`;
}

export function repoExists(userId: string): boolean {
  return existsSync(`${repoPathFor(userId)}/.git`);
}

export interface GitRunOptions {
  /** Run as this user via sudo. If omitted, run as the current process user. */
  asUser?: string;
  /** Working directory (defaults to repoPathFor(asUser) if asUser given) */
  cwd?: string;
  /** Optional stdin (used for git apply / git am) */
  stdin?: string;
  /** Max output bytes (default 5 MB) */
  maxBuffer?: number;
}

export async function runGit(args: string[], opts: GitRunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const cwd = opts.cwd ?? (opts.asUser ? repoPathFor(opts.asUser) : process.cwd());
  const maxBuffer = opts.maxBuffer ?? 5 * 1024 * 1024;

  let cmd: string;
  let cmdArgs: string[];

  if (opts.asUser && opts.asUser !== process.env.USER) {
    cmd = 'sudo';
    cmdArgs = ['-u', opts.asUser, '-n', '/usr/bin/git', '-C', cwd, ...args];
  } else {
    cmd = '/usr/bin/git';
    cmdArgs = ['-C', cwd, ...args];
  }

  const child = execFile(cmd, cmdArgs, { maxBuffer, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

  if (opts.stdin && child.stdin) {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`git exited ${code}: ${stderr.trim() || stdout.trim()}`), { code, stderr, stdout }));
    });
  });
}

/** Convenience wrapper that captures stdout only. */
export async function gitOut(args: string[], opts: GitRunOptions = {}): Promise<string> {
  const { stdout } = await runGit(args, opts);
  return stdout.trim();
}
