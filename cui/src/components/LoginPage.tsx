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
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0a0a0f',
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      position: 'relative',
      overflow: 'hidden',
      padding: '1rem',
    }}>
      {/* Background Orbs */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{
          position: 'absolute', top: '25%', left: '25%',
          width: 384, height: 384,
          background: 'rgba(222,193,94,0.08)',
          borderRadius: '50%', filter: 'blur(80px)',
        }} />
        <div style={{
          position: 'absolute', bottom: '25%', right: '25%',
          width: 384, height: 384,
          background: 'rgba(59,130,246,0.06)',
          borderRadius: '50%', filter: 'blur(80px)',
        }} />
        <div style={{
          position: 'absolute', top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 600, height: 600,
          background: 'radial-gradient(circle, rgba(222,193,94,0.04) 0%, transparent 70%)',
          borderRadius: '50%',
        }} />
      </div>

      <div style={{ maxWidth: 440, width: '100%', position: 'relative', zIndex: 10 }}>
        {/* Logo & Title */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 80, height: 80,
            borderRadius: 16,
            marginBottom: 24,
            boxShadow: '0 8px 32px rgba(222,193,94,0.2)',
            overflow: 'hidden',
          }}>
            <img
              src="/werking-logo.png"
              alt="WerkING"
              style={{ width: 80, height: 80, display: 'block' }}
            />
          </div>
          <h1 style={{
            fontSize: 30,
            fontWeight: 800,
            color: '#ffffff',
            marginBottom: 8,
            letterSpacing: '-0.02em',
          }}>
            Werk<span style={{ color: '#dec15e' }}>ING</span> Partner
          </h1>
          <p style={{
            fontSize: 14,
            color: 'rgba(255,255,255,0.4)',
          }}>
            Partner Plattform
          </p>
        </div>

        {/* Login Card */}
        <form
          onSubmit={handleSubmit}
          style={{
            background: 'rgba(255,255,255,0.03)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 16,
            padding: 32,
            boxShadow: '0 25px 60px rgba(0,0,0,0.4)',
          }}
        >
          {error && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: 16,
              background: 'rgba(239,68,68,0.1)',
              border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: 12,
              marginBottom: 24,
              fontSize: 13,
              color: '#fca5a5',
            }}>
              {error}
            </div>
          )}

          {/* User Field */}
          <div style={{ marginBottom: 20 }}>
            <label style={{
              display: 'block',
              fontSize: 13,
              fontWeight: 500,
              color: 'rgba(255,255,255,0.6)',
              marginBottom: 8,
            }}>
              Benutzer
            </label>
            <input
              type="text"
              value={user}
              onChange={e => setUser(e.target.value)}
              required
              autoFocus
              placeholder="user-id"
              style={{
                width: '100%',
                padding: '14px 16px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12,
                color: '#ffffff',
                fontSize: 15,
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'all 0.2s',
              }}
              onFocus={e => {
                e.target.style.borderColor = 'rgba(222,193,94,0.5)';
                e.target.style.boxShadow = '0 0 0 3px rgba(222,193,94,0.15)';
                e.target.style.background = 'rgba(255,255,255,0.06)';
              }}
              onBlur={e => {
                e.target.style.borderColor = 'rgba(255,255,255,0.1)';
                e.target.style.boxShadow = 'none';
                e.target.style.background = 'rgba(255,255,255,0.03)';
              }}
            />
          </div>

          {/* Password Field */}
          <div style={{ marginBottom: 28 }}>
            <label style={{
              display: 'block',
              fontSize: 13,
              fontWeight: 500,
              color: 'rgba(255,255,255,0.6)',
              marginBottom: 8,
            }}>
              Passwort
            </label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              style={{
                width: '100%',
                padding: '14px 16px',
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 12,
                color: '#ffffff',
                fontSize: 15,
                outline: 'none',
                boxSizing: 'border-box',
                transition: 'all 0.2s',
              }}
              onFocus={e => {
                e.target.style.borderColor = 'rgba(222,193,94,0.5)';
                e.target.style.boxShadow = '0 0 0 3px rgba(222,193,94,0.15)';
                e.target.style.background = 'rgba(255,255,255,0.06)';
              }}
              onBlur={e => {
                e.target.style.borderColor = 'rgba(255,255,255,0.1)';
                e.target.style.boxShadow = 'none';
                e.target.style.background = 'rgba(255,255,255,0.03)';
              }}
            />
          </div>

          {/* Submit Button */}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '14px',
              background: loading
                ? 'rgba(255,255,255,0.1)'
                : 'linear-gradient(135deg, #dec15e 0%, #c9a83e 100%)',
              color: loading ? 'rgba(255,255,255,0.4)' : '#0a0a0f',
              border: 'none',
              borderRadius: 12,
              fontSize: 15,
              fontWeight: 700,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s',
              boxShadow: loading ? 'none' : '0 4px 24px rgba(222,193,94,0.25)',
              letterSpacing: '0.02em',
            }}
            onMouseEnter={e => {
              if (!loading) {
                e.currentTarget.style.background = 'linear-gradient(135deg, #e8cc6a 0%, #d4b348 100%)';
                e.currentTarget.style.boxShadow = '0 6px 32px rgba(222,193,94,0.35)';
                e.currentTarget.style.transform = 'translateY(-1px)';
              }
            }}
            onMouseLeave={e => {
              if (!loading) {
                e.currentTarget.style.background = 'linear-gradient(135deg, #dec15e 0%, #c9a83e 100%)';
                e.currentTarget.style.boxShadow = '0 4px 24px rgba(222,193,94,0.25)';
                e.currentTarget.style.transform = 'translateY(0)';
              }
            }}
          >
            {loading ? 'Anmeldung...' : 'Anmelden'}
          </button>
        </form>

        {/* Footer */}
        <p style={{
          fontSize: 12,
          color: 'rgba(255,255,255,0.2)',
          textAlign: 'center',
          marginTop: 24,
        }}>
          Powered by <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>Werkingflow</span>
        </p>
      </div>
    </div>
  );
}
