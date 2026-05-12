import React, { useEffect, useState, useCallback } from 'react';
import { CommitGraph } from './git/CommitGraph';
import { BranchList } from './git/BranchList';
import { WorkingTree } from './git/WorkingTree';
import type { GitRepo, GitCommit, GitBranch, GitStatusResponse } from './git/types';

type View = 'commits' | 'branches' | 'changes';

export default function GitTab() {
  const [repos, setRepos] = useState<GitRepo[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [reposError, setReposError] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [view, setView] = useState<View>('commits');

  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [refs, setRefs] = useState<Record<string, string[]>>({});
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [commitsLoading, setCommitsLoading] = useState(false);

  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [status, setStatus] = useState<GitStatusResponse | null>(null);

  const [filter, setFilter] = useState('');

  // Initial repo list
  useEffect(() => {
    if (window.__cuiServerAlive === false) return;
    setReposLoading(true);
    fetch('/api/git/repos')
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        setRepos(d.repos || []);
        if (d.repos?.length && !selectedRepo) setSelectedRepo(d.repos[0].path);
      })
      .catch(e => setReposError(e.message))
      .finally(() => setReposLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRepoData = useCallback(async (repoPath: string) => {
    if (window.__cuiServerAlive === false) return;
    setCommitsLoading(true);
    setSelectedSha(null);
    try {
      const enc = encodeURIComponent(repoPath);
      const [cRes, bRes, sRes] = await Promise.all([
        fetch(`/api/git/commits?repo=${enc}&limit=80`).then(r => r.ok ? r.json() : { commits: [], refs: {} }),
        fetch(`/api/git/branches?repo=${enc}`).then(r => r.ok ? r.json() : { branches: [] }),
        fetch(`/api/git/status?repo=${enc}`).then(r => r.ok ? r.json() : null),
      ]);
      setCommits(cRes.commits || []);
      setRefs(cRes.refs || {});
      setBranches(bRes.branches || []);
      setStatus(sRes);
    } catch (e: any) {
      console.warn('[GitTab] loadRepoData failed', e);
    } finally {
      setCommitsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedRepo) loadRepoData(selectedRepo);
  }, [selectedRepo, loadRepoData]);

  const refreshAll = async () => {
    await fetch('/api/git/refresh', { method: 'POST' }).catch(() => {});
    const r = await fetch('/api/git/repos').then(r => r.json()).catch(() => null);
    if (r) setRepos(r.repos || []);
    if (selectedRepo) await loadRepoData(selectedRepo);
  };

  const filteredRepos = filter
    ? repos.filter(r => r.name.toLowerCase().includes(filter.toLowerCase()))
    : repos;

  if (reposLoading) return <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 11 }}>Loading repositories...</div>;
  if (reposError) return <div style={{ padding: 16, color: 'var(--tn-red)', fontSize: 11 }}>{reposError}</div>;

  return (
    <div data-ai-id="git-tab" style={{ display: 'flex', height: '100%', minHeight: 0, fontFamily: 'inherit' }}>
      {/* Sidebar: Repo list */}
      <div data-ai-id="git-tab-sidebar" style={{
        width: 240,
        flexShrink: 0,
        borderRight: '1px solid var(--tn-border)',
        background: 'var(--tn-bg-dark)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}>
        <div style={{ padding: 8, borderBottom: '1px solid var(--tn-border)' }}>
          <input
            data-ai-id="git-tab-repo-filter"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder={`Filter (${repos.length} repos)`}
            style={{
              width: '100%',
              background: 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              borderRadius: 3,
              padding: '4px 6px',
              color: 'var(--tn-text)',
              fontSize: 11,
              fontFamily: 'monospace',
            }}
          />
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {filteredRepos.map(r => {
            const isSel = r.path === selectedRepo;
            return (
              <div
                key={r.path}
                data-ai-id={`git-tab-repo-${r.name}`}
                onClick={() => setSelectedRepo(r.path)}
                style={{
                  padding: '8px 10px',
                  cursor: 'pointer',
                  background: isSel ? 'rgba(122,162,247,0.18)' : 'transparent',
                  borderLeft: isSel ? '2px solid var(--tn-blue)' : '2px solid transparent',
                  borderBottom: '1px solid var(--tn-border)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: r.dirty ? 'var(--tn-yellow)' : 'var(--tn-green)',
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.name}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 3, alignItems: 'center', fontSize: 9, fontFamily: 'monospace' }}>
                  <span style={{
                    background: 'rgba(122,162,247,0.15)',
                    color: 'var(--tn-blue)',
                    padding: '1px 4px',
                    borderRadius: 2,
                  }}>{r.branch}</span>
                  {r.dirty && (
                    <span style={{ color: 'var(--tn-yellow)' }}>{r.uncommitted}△</span>
                  )}
                </div>
              </div>
            );
          })}
          {filteredRepos.length === 0 && (
            <div style={{ padding: 16, fontSize: 10, color: 'var(--tn-text-muted)' }}>No repos match.</div>
          )}
        </div>
      </div>

      {/* Main detail */}
      <div data-ai-id="git-tab-detail" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
        {/* Detail header: repo name + view tabs + refresh */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px',
          borderBottom: '1px solid var(--tn-border)',
          background: 'var(--tn-bg-dark)',
          flexShrink: 0,
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--tn-text)' }}>
            {selectedRepo ? selectedRepo.split('/').pop() : '—'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--tn-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {selectedRepo}
          </span>
          <div style={{ display: 'flex', gap: 2 }}>
            {(['commits', 'branches', 'changes'] as const).map(v => (
              <button
                key={v}
                data-ai-id={`git-tab-view-${v}`}
                onClick={() => setView(v)}
                style={{
                  background: view === v ? 'var(--tn-blue)' : 'transparent',
                  border: '1px solid var(--tn-border)',
                  color: view === v ? '#fff' : 'var(--tn-text-muted)',
                  padding: '3px 8px',
                  borderRadius: 3,
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  textTransform: 'capitalize',
                }}
              >
                {v}
                {v === 'changes' && status && status.files.length > 0 && (
                  <span style={{ marginLeft: 4, color: view === v ? '#fff' : 'var(--tn-yellow)' }}>
                    {status.files.length}
                  </span>
                )}
              </button>
            ))}
          </div>
          <button
            data-ai-id="git-tab-refresh"
            onClick={refreshAll}
            style={{
              background: 'rgba(122,162,247,0.15)',
              border: '1px solid rgba(122,162,247,0.3)',
              borderRadius: 3,
              padding: '3px 8px',
              fontSize: 9,
              color: 'var(--tn-blue)',
              cursor: 'pointer',
              fontFamily: 'monospace',
              fontWeight: 700,
            }}
          >
            Refresh
          </button>
        </div>

        {/* View content */}
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {commitsLoading ? (
            <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 11 }}>Loading...</div>
          ) : !selectedRepo ? (
            <div style={{ padding: 16, color: 'var(--tn-text-muted)', fontSize: 11 }}>Select a repository.</div>
          ) : view === 'commits' ? (
            <CommitGraph commits={commits} refs={refs} selectedSha={selectedSha} onSelect={setSelectedSha} />
          ) : view === 'branches' ? (
            <BranchList branches={branches} />
          ) : (
            <WorkingTree status={status} />
          )}
        </div>
      </div>
    </div>
  );
}
