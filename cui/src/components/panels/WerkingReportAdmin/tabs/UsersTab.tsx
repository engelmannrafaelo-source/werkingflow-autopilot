import { useState, useEffect, useCallback } from 'react';

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

export default function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/wr/users');
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setUsers(data.users || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleApprove = async (userId: string) => {
    setProcessingIds(prev => new Set(prev).add(userId));
    try {
      const res = await fetch(`/api/admin/wr/users/${userId}/approve`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchUsers(); // Refresh list
    } catch (err: any) {
      alert(`Failed to approve: ${err.message}`);
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  };

  const handleVerify = async (userId: string) => {
    setProcessingIds(prev => new Set(prev).add(userId));
    try {
      const res = await fetch(`/api/admin/wr/users/${userId}/verify`, {
        method: 'POST',
      });
      if (!res.ok) throw new Error(await res.text());
      await fetchUsers(); // Refresh list
    } catch (err: any) {
      alert(`Failed to verify: ${err.message}`);
    } finally {
      setProcessingIds(prev => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  };

  const filteredUsers = users.filter(u => {
    if (filter === 'pending') return !u.approved;
    if (filter === 'unverified') return !u.emailVerified && u.approved;
    return true;
  });

  return (
    <div style={{ padding: 12 }}>
      {/* Filter Bar */}
      <div style={{
        display: 'flex',
        gap: 6,
        marginBottom: 12,
        alignItems: 'center',
      }}>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)', fontWeight: 600 }}>Filter:</span>
        {(['all', 'pending', 'unverified'] as FilterType[]).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '3px 10px',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              cursor: 'pointer',
              background: filter === f ? 'rgba(122,162,247,0.2)' : 'var(--tn-bg)',
              border: `1px solid ${filter === f ? 'var(--tn-blue)' : 'var(--tn-border)'}`,
              color: filter === f ? 'var(--tn-blue)' : 'var(--tn-text-muted)',
              textTransform: 'capitalize',
            }}
          >
            {f}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          onClick={fetchUsers}
          style={{
            padding: '3px 10px',
            borderRadius: 3,
            fontSize: 10,
            cursor: 'pointer',
            background: 'var(--tn-bg)',
            border: '1px solid var(--tn-border)',
            color: 'var(--tn-text-muted)',
          }}
        >
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div style={{
          padding: '4px 8px',
          fontSize: 11,
          color: 'var(--tn-red)',
          background: 'rgba(247,118,142,0.1)',
          borderRadius: 3,
          marginBottom: 8,
        }}>
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div style={{
          padding: 20,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 12,
        }}>
          Loading...
        </div>
      )}

      {/* User List */}
      {!loading && filteredUsers.length === 0 && (
        <div style={{
          padding: 20,
          textAlign: 'center',
          color: 'var(--tn-text-muted)',
          fontSize: 11,
        }}>
          No users found
        </div>
      )}

      {!loading && filteredUsers.length > 0 && (
        <div>
          {/* Table Header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '200px 150px 100px 80px 80px 1fr',
            gap: 8,
            padding: '6px 10px',
            background: 'var(--tn-bg-dark)',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--tn-text-muted)',
            marginBottom: 4,
          }}>
            <div>Email</div>
            <div>Name</div>
            <div>Tenant</div>
            <div>Approved</div>
            <div>Verified</div>
            <div>Actions</div>
          </div>

          {/* Table Rows */}
          {filteredUsers.map(user => {
            const isProcessing = processingIds.has(user.id);
            return (
              <div
                key={user.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '200px 150px 100px 80px 80px 1fr',
                  gap: 8,
                  padding: '8px 10px',
                  borderBottom: '1px solid var(--tn-border)',
                  fontSize: 11,
                  alignItems: 'center',
                }}
              >
                <div style={{
                  color: 'var(--tn-text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {user.email}
                </div>
                <div style={{ color: 'var(--tn-text-subtle)' }}>{user.name}</div>
                <div style={{
                  color: 'var(--tn-text-muted)',
                  fontSize: 10,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}>
                  {user.tenantName || user.tenantId || '-'}
                </div>
                <div>
                  <span style={{
                    display: 'inline-block',
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontSize: 9,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    background: user.approved ? 'rgba(158,206,106,0.2)' : 'rgba(224,175,104,0.2)',
                    color: user.approved ? 'var(--tn-green)' : 'var(--tn-orange)',
                  }}>
                    {user.approved ? 'Yes' : 'No'}
                  </span>
                </div>
                <div>
                  <span style={{
                    display: 'inline-block',
                    padding: '2px 6px',
                    borderRadius: 3,
                    fontSize: 9,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    background: user.emailVerified ? 'rgba(158,206,106,0.2)' : 'rgba(247,118,142,0.2)',
                    color: user.emailVerified ? 'var(--tn-green)' : 'var(--tn-red)',
                  }}>
                    {user.emailVerified ? 'Yes' : 'No'}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {!user.approved && (
                    <button
                      onClick={() => handleApprove(user.id)}
                      disabled={isProcessing}
                      style={{
                        padding: '3px 8px',
                        borderRadius: 3,
                        fontSize: 10,
                        cursor: isProcessing ? 'not-allowed' : 'pointer',
                        background: isProcessing ? 'var(--tn-border)' : 'var(--tn-green)',
                        border: 'none',
                        color: '#fff',
                        fontWeight: 600,
                        opacity: isProcessing ? 0.5 : 1,
                      }}
                    >
                      {isProcessing ? 'Processing...' : 'Approve'}
                    </button>
                  )}
                  {user.approved && !user.emailVerified && (
                    <button
                      onClick={() => handleVerify(user.id)}
                      disabled={isProcessing}
                      style={{
                        padding: '3px 8px',
                        borderRadius: 3,
                        fontSize: 10,
                        cursor: isProcessing ? 'not-allowed' : 'pointer',
                        background: isProcessing ? 'var(--tn-border)' : 'var(--tn-blue)',
                        border: 'none',
                        color: '#fff',
                        fontWeight: 600,
                        opacity: isProcessing ? 0.5 : 1,
                      }}
                    >
                      {isProcessing ? 'Processing...' : 'Verify'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
