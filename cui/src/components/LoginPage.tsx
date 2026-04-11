/**
 * Login Page — shown when auth is enabled and user is not authenticated.
 */

import { useState, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    const result = await login(user, password);
    if (!result.ok) {
      setError(result.error || 'Login failed');
    }
    setLoading(false);
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#1a1b26',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#24283b',
          border: '1px solid #3b4261',
          borderRadius: 12,
          padding: '2.5rem',
          width: '100%',
          maxWidth: 380,
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <img src="/werking-logo.png" alt="WerkING" style={{ width: 56, height: 56, borderRadius: 12 }} />
        </div>
        <h1 style={{
          fontSize: 20,
          fontWeight: 700,
          color: '#c0caf5',
          marginBottom: 8,
          textAlign: 'center',
        }}>
          WerkING Lab
        </h1>
        <p style={{
          fontSize: 12,
          color: '#565f89',
          marginBottom: 24,
          textAlign: 'center',
        }}>
          Partner Workspace
        </p>

        {error && (
          <div style={{
            background: 'rgba(247,118,142,0.1)',
            border: '1px solid rgba(247,118,142,0.3)',
            borderRadius: 6,
            padding: '8px 12px',
            marginBottom: 16,
            fontSize: 12,
            color: '#f7768e',
          }}>
            {error}
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 11, color: '#7982a9', marginBottom: 6, fontWeight: 600 }}>
            User
          </label>
          <input
            type="text"
            value={user}
            onChange={e => setUser(e.target.value)}
            required
            autoFocus
            style={{
              width: '100%',
              padding: '10px 12px',
              background: '#1a1b26',
              border: '1px solid #3b4261',
              borderRadius: 6,
              color: '#c0caf5',
              fontSize: 13,
              outline: 'none',
              boxSizing: 'border-box',
            }}
            placeholder="user-id"
          />
        </div>

        <div style={{ marginBottom: 24 }}>
          <label style={{ display: 'block', fontSize: 11, color: '#7982a9', marginBottom: 6, fontWeight: 600 }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            style={{
              width: '100%',
              padding: '10px 12px',
              background: '#1a1b26',
              border: '1px solid #3b4261',
              borderRadius: 6,
              color: '#c0caf5',
              fontSize: 13,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          style={{
            width: '100%',
            padding: '10px',
            background: loading ? '#3b4261' : '#7aa2f7',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            transition: 'background 0.2s',
          }}
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
