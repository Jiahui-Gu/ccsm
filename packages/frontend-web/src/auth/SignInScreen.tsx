// SignInScreen — the full-page placeholder rendered when the SPA has no
// web JWT. A single primary CTA hard-redirects to /api/auth/github/login,
// matching the cf-worker route landed in Task #140 (S4-T3).
//
// Intentionally minimal: ccsm wordmark + one button. The actual product UI
// only loads after the OAuth callback writes a JWT into sessionStorage and
// SignInGate flips to children.

import { useAuth } from './AuthContext';

export function SignInScreen() {
  const { signIn, loading } = useAuth();
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        color: '#e6e6e6',
        background: '#101216',
        padding: 24,
      }}
    >
      <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: 0.5 }}>ccsm</div>
      <div style={{ color: '#9aa0a6', fontSize: 14, maxWidth: 360, textAlign: 'center' }}>
        Sign in with your GitHub account to continue.
      </div>
      <button
        type="button"
        onClick={signIn}
        disabled={loading}
        style={{
          appearance: 'none',
          border: 'none',
          background: '#24292f',
          color: 'white',
          fontSize: 14,
          fontWeight: 500,
          padding: '10px 18px',
          borderRadius: 6,
          cursor: loading ? 'progress' : 'pointer',
          opacity: loading ? 0.6 : 1,
        }}
      >
        Sign in with GitHub
      </button>
    </div>
  );
}
