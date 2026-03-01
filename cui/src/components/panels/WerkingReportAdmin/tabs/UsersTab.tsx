import { useState, useEffect, useCallback } from 'react';
import PaginationControls from '@/components/shared/PaginationControls';
import TableSearch, { FilterConfig } from '@/components/shared/TableSearch';
import ExportButton from '@/components/shared/ExportButton';

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  tenantId?: string;
  tenantName?: string | null;
  approved: boolean;
  emailVerified: boolean;
  createdAt: string;
  lastLogin?: string;
}

type FilterType = 'all' | 'pending' | 'unverified';

export default function UsersTab({ envMode }: { envMode?: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // Pagination state
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);
  const [total, setTotal] = useState(0);

  // Create form state
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [creating, setCreating] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        offset: offset.toString(),
        limit: limit.toString(),
      });
      const res = await fetch(`/api/admin/wr/users?${params}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setUsers(data.users || []);
      setTotal(data.total || 0);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [offset, limit]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers, envMode]);

  const handleApprove = async (userId: string) => {
    setProcessingIds(prev => new Set(prev).add(userId));
    try {
      const res = await fetch(`/api/admin/wr/users/${userId}/approve`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      await fetchUsers();
    } catch (err: any) {
      alert(`Failed to approve: ${err.message}`);
    } finally {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(userId); return next; });
    }
  };

  const handleVerify = async (userId: string) => {
    setProcessingIds(prev => new Set(prev).add(userId));
    try {
      const res = await fetch(`/api/admin/wr/users/${userId}/verify`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      await fetchUsers();
    } catch (err: any) {
      alert(`Failed to verify: ${err.message}`);
    } finally {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(userId); return next; });
    }
  };

  const handleCreate = async () => {
    if (!newEmail.trim() || !newPassword.trim()) {
      setError('Email and password are required');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newEmail,
          password: newPassword,
          name: newName,
          role: newRole,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || data.msg || `HTTP ${res.status}`);
      }
      setNewEmail('');
      setNewPassword('');
      setNewName('');
      setNewRole('user');
      setShowCreate(false);
      await fetchUsers();
    } catch (err: any) {
      setError(`Create failed: ${err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (userId: string, email: string) => {
    if (!confirm(`Delete user "${email}"? This cannot be undone.`)) return;
    setProcessingIds(prev => new Set(prev).add(userId));
    try {
      const res = await fetch(`/api/admin/wr/users/${userId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchUsers();
    } catch (err: any) {
      alert(`Delete failed: ${err.message}`);
    } finally {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(userId); return next; });
    }
  };

  const handleImpersonate = async (userId: string, email: string) => {
    if (!confirm(`Start impersonation session as "${email}"?`)) return;
    setProcessingIds(prev => new Set(prev).add(userId));
    try {
      const res = await fetch(`/api/admin/wr/users/${userId}/impersonate`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const sessionId = data.session?.id || 'unknown';
      const expiresAt = data.session?.expiresAt ? new Date(data.session.expiresAt).toLocaleString('de-DE') : 'unknown';
      alert(`Impersonation session started!\n\nSession ID: ${sessionId}\nTarget: ${email}\nExpires: ${expiresAt}\n\nSession is now active.`);
    } catch (err: any) {
      alert(`Impersonation failed: ${err.message}`);
    } finally {
      setProcessingIds(prev => { const next = new Set(prev); next.delete(userId); return next; });
    }
  };

  // Apply client-side filtering (after pagination from server)
  const filteredUsers = users
    .filter(u => {
      if (filter === 'pending') return !u.approved;
      if (filter === 'unverified') return !u.emailVerified && u.approved;
      return true;
    })
    .filter(u => {
      if (!search) return true;
      const s = search.toLowerCase();
      return u.email.toLowerCase().includes(s) || u.name?.toLowerCase().includes(s) || u.tenantName?.toLowerCase().includes(s);
    })
    .filter(u => {
      if (roleFilter && u.role !== roleFilter) return false;
      if (statusFilter === 'verified' && !u.emailVerified) return false;
      if (statusFilter === 'unverified' && u.emailVerified) return false;
      if (statusFilter === 'approved' && !u.approved) return false;
      if (statusFilter === 'pending' && u.approved) return false;
      return true;
    });

  const handlePageChange = (newOffset: number) => {
    setOffset(newOffset);
  };

  const handlePageSizeChange = (newLimit: number) => {
    setLimit(newLimit);
    setOffset(0); // Reset to first page when changing page size
  };

  const handleSearchChange = useCallback((query: string, filters: Record<string, string>) => {
    setSearch(query);
    setRoleFilter(filters.role || '');
    setStatusFilter(filters.status || '');
  }, []);

  const searchFilters: FilterConfig[] = [
    {
      key: 'role',
      label: 'Role',
      options: [
        { label: 'Admin', value: 'admin' },
        { label: 'User', value: 'user' },
      ],
      placeholder: 'All Roles',
    },
    {
      key: 'status',
      label: 'Status',
      options: [
        { label: 'Verified', value: 'verified' },
        { label: 'Unverified', value: 'unverified' },
        { label: 'Approved', value: 'approved' },
        { label: 'Pending', value: 'pending' },
      ],
      placeholder: 'All Statuses',
    },
  ];

  const inputStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 3, fontSize: 11, background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)', color: 'var(--tn-text)', outline: 'none', width: '100%',
  };

  return (
    <div data-ai-id="wr-users-tab" style={{ padding: 12 }}>
      {/* Search and Filter Bar */}
      <div data-ai-id="wr-users-filter-bar" style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* Quick Filter Buttons */}
        <span data-ai-id="wr-users-quick-label" style={{ fontSize: 11, color: 'var(--tn-text-muted)', fontWeight: 600 }}>Quick:</span>
        {(['all', 'pending', 'unverified'] as FilterType[]).map(f => (
          <button key={f} data-ai-id={`wr-users-quick-${f}`} data-active={filter === f} onClick={() => setFilter(f)} style={{
            padding: '3px 10px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: 'pointer',
            background: filter === f ? 'rgba(122,162,247,0.2)' : 'var(--tn-bg)',
            border: `1px solid ${filter === f ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
            color: filter === f ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
            textTransform: 'capitalize',
          }}>{f}</button>
        ))}
        <div style={{ width: 1, height: 20, background: 'var(--tn-border)', margin: '0 4px' }} />

        {/* Enhanced Search */}
        <TableSearch
          onSearch={handleSearchChange}
          placeholder="Search users..."
          filters={searchFilters}
          initialQuery={search}
          initialFilters={{ role: roleFilter, status: statusFilter }}
        />

        <div style={{ flex: 1 }} />
        <ExportButton
          data={filteredUsers.map(u => ({
            email: u.email,
            name: u.name || '',
            role: u.role,
            approved: u.approved ? 'Yes' : 'No',
            emailVerified: u.emailVerified ? 'Yes' : 'No',
            tenant: u.tenantName || u.tenantId || '',
            createdAt: u.createdAt,
            lastLogin: u.lastLogin || '',
          }))}
          filename="users"
        />
        <button data-ai-id="wr-users-create-btn" data-active={showCreate} onClick={() => setShowCreate(!showCreate)} style={{
          padding: '4px 12px', borderRadius: 3, fontSize: 10, fontWeight: 600, cursor: 'pointer',
          background: showCreate ? 'var(--tn-red)' : 'var(--tn-green)', border: 'none', color: '#fff',
        }}>
          {showCreate ? 'Cancel' : '+ New User'}
        </button>
        <button data-ai-id="wr-users-refresh-btn" onClick={fetchUsers} style={{
          padding: '3px 10px', borderRadius: 3, fontSize: 10, cursor: 'pointer',
          background: 'var(--tn-bg)', border: '1px solid var(--tn-border)', color: 'var(--tn-text-muted)',
        }}>Refresh</button>
      </div>

      {/* Create User Form */}
      {showCreate && (
        <div data-ai-id="wr-users-create-form" style={{
          background: 'var(--tn-bg-dark)', border: '1px solid var(--tn-green)', borderRadius: 6,
          padding: 12, marginBottom: 12,
        }}>
          <div data-ai-id="wr-users-create-title" style={{ fontSize: 11, fontWeight: 600, color: 'var(--tn-green)', marginBottom: 8 }}>Create New User (Supabase Auth)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 80px auto', gap: 8, alignItems: 'end' }}>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Email *</div>
              <input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="user@example.com" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Password *</div>
              <input value={newPassword} onChange={e => setNewPassword(e.target.value)} type="password" placeholder="Min. 8 chars" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Name</div>
              <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Full Name" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 9, color: 'var(--tn-text-muted)', marginBottom: 3 }}>Role</div>
              <select value={newRole} onChange={e => setNewRole(e.target.value)} style={inputStyle}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <button data-ai-id="wr-users-create-submit" onClick={handleCreate} disabled={creating || !newEmail.trim() || !newPassword.trim()} style={{
              padding: '5px 14px', borderRadius: 3, fontSize: 10, fontWeight: 600,
              cursor: creating ? 'not-allowed' : 'pointer',
              background: 'var(--tn-green)', border: 'none', color: '#fff', opacity: creating ? 0.5 : 1,
            }}>
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div data-ai-id="wr-users-error" style={{ padding: '4px 8px', fontSize: 11, color: 'var(--tn-red)', background: 'rgba(247,118,142,0.1)', borderRadius: 3, marginBottom: 8 }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div data-ai-id="wr-users-loading" style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 12 }}>Loading...</div>
      )}

      {/* Pagination Controls - Top */}
      {!loading && total > 0 && (
        <PaginationControls
          total={total}
          offset={offset}
          limit={limit}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
        />
      )}

      {/* User Count */}
      {!loading && (
        <div data-ai-id="wr-users-count" style={{ fontSize: 10, color: 'var(--tn-text-muted)', marginBottom: 6, marginTop: 6 }}>
          {filteredUsers.length} user(s) shown
          {filter !== 'all' && ` (quick: ${filter})`}
          {search && ` matching "${search}"`}
          {roleFilter && ` | role: ${roleFilter}`}
          {statusFilter && ` | status: ${statusFilter}`}
        </div>
      )}

      {/* User List */}
      {!loading && filteredUsers.length === 0 && (
        <div data-ai-id="wr-users-empty" style={{ padding: 20, textAlign: 'center', color: 'var(--tn-text-muted)', fontSize: 11 }}>No users found</div>
      )}

      {!loading && filteredUsers.length > 0 && (
        <div data-ai-id="wr-users-table">
          {/* Table Header */}
          <div data-ai-id="wr-users-table-header" style={{
            display: 'grid', gridTemplateColumns: '1fr 120px 100px 60px 60px 60px 180px',
            gap: 8, padding: '6px 10px', background: 'var(--tn-bg-dark)', borderRadius: 4,
            fontSize: 10, fontWeight: 600, color: 'var(--tn-text-muted)', marginBottom: 4,
          }}>
            <div>Email</div><div>Name</div><div>Tenant</div><div>Role</div><div>Appr.</div><div>Verif.</div><div>Actions</div>
          </div>

          {/* Table Rows */}
          {filteredUsers.map(user => {
            const isProcessing = processingIds.has(user.id);
            return (
              <div key={user.id} data-ai-id={`wr-users-row-${user.id}`} style={{
                display: 'grid', gridTemplateColumns: '1fr 120px 100px 60px 60px 60px 180px',
                gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--tn-border)',
                fontSize: 11, alignItems: 'center', opacity: isProcessing ? 0.5 : 1,
              }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span style={{ color: 'var(--tn-text)' }}>{user.email}</span>
                  {user.lastLogin && (
                    <div style={{ fontSize: 9, color: 'var(--tn-text-muted)' }}>
                      Last: {new Date(user.lastLogin).toLocaleDateString('de-DE')}
                    </div>
                  )}
                </div>
                <div style={{ color: 'var(--tn-text-subtle)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.name}</div>
                <div style={{ color: 'var(--tn-text-muted)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {user.tenantName || user.tenantId?.slice(0, 8) || '—'}
                </div>
                <div>
                  <span style={{
                    padding: '2px 5px', borderRadius: 3, fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                    background: user.role === 'admin' ? 'rgba(122,162,247,0.2)' : 'rgba(158,206,106,0.1)',
                    color: user.role === 'admin' ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
                  }}>{user.role}</span>
                </div>
                <div>
                  <span style={{
                    display: 'inline-block', padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                    background: user.approved ? 'rgba(158,206,106,0.2)' : 'rgba(224,175,104,0.2)',
                    color: user.approved ? 'var(--tn-green)' : 'var(--tn-orange)',
                  }}>{user.approved ? 'Yes' : 'No'}</span>
                </div>
                <div>
                  <span style={{
                    display: 'inline-block', padding: '2px 6px', borderRadius: 3, fontSize: 9, fontWeight: 600, textTransform: 'uppercase',
                    background: user.emailVerified ? 'rgba(158,206,106,0.2)' : 'rgba(247,118,142,0.2)',
                    color: user.emailVerified ? 'var(--tn-green)' : 'var(--tn-red)',
                  }}>{user.emailVerified ? 'Yes' : 'No'}</span>
                </div>
                <div data-ai-id={`wr-users-actions-${user.id}`} style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  {!user.approved && (
                    <button data-ai-id={`wr-users-approve-${user.id}`} onClick={() => handleApprove(user.id)} disabled={isProcessing} style={{
                      padding: '3px 6px', borderRadius: 3, fontSize: 9, cursor: isProcessing ? 'not-allowed' : 'pointer',
                      background: 'var(--tn-green)', border: 'none', color: '#fff', fontWeight: 600,
                    }}>{isProcessing ? '...' : 'Approve'}</button>
                  )}
                  {user.approved && !user.emailVerified && (
                    <button data-ai-id={`wr-users-verify-${user.id}`} onClick={() => handleVerify(user.id)} disabled={isProcessing} style={{
                      padding: '3px 6px', borderRadius: 3, fontSize: 9, cursor: isProcessing ? 'not-allowed' : 'pointer',
                      background: 'var(--tn-blue)', border: 'none', color: '#fff', fontWeight: 600,
                    }}>{isProcessing ? '...' : 'Verify'}</button>
                  )}
                  <button data-ai-id={`wr-users-impersonate-${user.id}`} onClick={() => handleImpersonate(user.id, user.email)} disabled={isProcessing} style={{
                    padding: '3px 6px', borderRadius: 3, fontSize: 9, cursor: isProcessing ? 'not-allowed' : 'pointer',
                    background: 'var(--tn-blue)', border: 'none', color: '#fff', fontWeight: 600,
                  }}>{isProcessing ? '...' : 'Impersonate'}</button>
                  <button data-ai-id={`wr-users-delete-${user.id}`} onClick={() => handleDelete(user.id, user.email)} disabled={isProcessing} style={{
                    padding: '3px 6px', borderRadius: 3, fontSize: 9, cursor: isProcessing ? 'not-allowed' : 'pointer',
                    background: 'rgba(247,118,142,0.15)', border: '1px solid rgba(247,118,142,0.3)',
                    color: 'var(--tn-red)', fontWeight: 600,
                  }}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination Controls - Bottom */}
      {!loading && total > 0 && (
        <PaginationControls
          total={total}
          offset={offset}
          limit={limit}
          onPageChange={handlePageChange}
          onPageSizeChange={handlePageSizeChange}
        />
      )}
    </div>
  );
}
