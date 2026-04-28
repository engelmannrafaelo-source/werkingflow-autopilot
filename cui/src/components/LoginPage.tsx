/**
 * Login Page — shown when auth is enabled and user is not authenticated.
 */

import { useState, useEffect, type FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';

interface DownloadFile { name: string; size: number; mtime: string; }

function pickByPlatform(files: DownloadFile[]): { mac?: DownloadFile; win?: DownloadFile; linux?: DownloadFile } {
  const mac = files.find(f => /arm64.*mac\.zip$/i.test(f.name)) || files.find(f => /mac\.zip$/i.test(f.name));
  const win = files.find(f => /win\.zip$/i.test(f.name) || /\.exe$/i.test(f.name));
  const linux = files.find(f => /\.appimage$/i.test(f.name));
  return { mac, win, linux };
}

function fmtSize(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0) + ' MB';
}

function DownloadButton({ label, file, accent }: { label: string; file: DownloadFile | undefined; accent?: boolean }) {
  if (!file) {
    return (
      <div style={{
        flex: 1,
        padding: '10px 12px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px dashed rgba(255,255,255,0.08)',
        borderRadius: 10,
        color: 'rgba(255,255,255,0.25)',
        fontSize: 12,
        textAlign: 'center',
      }}>
        {label}<br/><span style={{ fontSize: 10 }}>nicht verfügbar</span>
      </div>
    );
  }
  return (
    <a
      href={`/downloads/${encodeURIComponent(file.name)}`}
      style={{
        flex: 1,
        padding: '10px 12px',
        background: accent ? 'rgba(222,193,94,0.08)' : 'rgba(255,255,255,0.04)',
        border: `1px solid ${accent ? 'rgba(222,193,94,0.3)' : 'rgba(255,255,255,0.1)'}`,
        borderRadius: 10,
        color: '#ffffff',
        fontSize: 13,
        fontWeight: 500,
        textAlign: 'center',
        textDecoration: 'none',
        transition: 'all 0.15s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.background = accent ? 'rgba(222,193,94,0.15)' : 'rgba(255,255,255,0.08)';
        e.currentTarget.style.borderColor = accent ? 'rgba(222,193,94,0.5)' : 'rgba(255,255,255,0.2)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.background = accent ? 'rgba(222,193,94,0.08)' : 'rgba(255,255,255,0.04)';
        e.currentTarget.style.borderColor = accent ? 'rgba(222,193,94,0.3)' : 'rgba(255,255,255,0.1)';
      }}
    >
      {label}
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>
        {fmtSize(file.size)}
      </div>
    </a>
  );
}

interface LoginInputProps {
  label: string;
  type: string;
  value: string;
  onChange: (val: string) => void;
  autoFocus?: boolean;
  placeholder?: string;
  marginBottom?: number;
}

function LoginInput({ label, type, value, onChange, autoFocus, placeholder, marginBottom = 20 }: LoginInputProps) {
  return (
    <div style={{ marginBottom }}>
      <label style={{
        display: 'block',
        fontSize: 13,
        fontWeight: 500,
        color: 'rgba(255,255,255,0.6)',
        marginBottom: 8,
      }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        required
        autoFocus={autoFocus}
        placeholder={placeholder}
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
  );
}

export default function LoginPage() {
  const { login } = useAuth();
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [downloads, setDownloads] = useState<DownloadFile[]>([]);

  useEffect(() => {
    fetch('/api/downloads/manifest')
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.available && Array.isArray(j.files)) setDownloads(j.files); })
      .catch(() => {});
  }, []);

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

          <LoginInput
            label="Benutzer"
            type="text"
            value={user}
            onChange={setUser}
            autoFocus
            placeholder="user-id"
            marginBottom={20}
          />

          <LoginInput
            label="Passwort"
            type="password"
            value={password}
            onChange={setPassword}
            marginBottom={28}
          />

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

        {/* Desktop Download Card */}
        {downloads.length > 0 && (() => {
          const picks = pickByPlatform(downloads);
          const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
          const isMac = /Mac/i.test(ua);
          const isWin = /Win/i.test(ua);
          return (
            <div style={{
              marginTop: 24,
              padding: 20,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 16,
            }}>
              <div style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'rgba(255,255,255,0.7)',
                marginBottom: 4,
              }}>
                Lieber als Desktop-App?
              </div>
              <div style={{
                fontSize: 12,
                color: 'rgba(255,255,255,0.4)',
                marginBottom: 14,
              }}>
                Eine eigene Anwendung statt Browser-Tab. Auto-Reconnect, kein Tab-Throttling.
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <DownloadButton label="macOS" file={picks.mac} accent={isMac} />
                <DownloadButton label="Windows" file={picks.win} accent={isWin} />
                <DownloadButton label="Linux" file={picks.linux} accent={!isMac && !isWin} />
              </div>
            </div>
          );
        })()}

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
