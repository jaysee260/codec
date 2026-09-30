import { useState, type FormEvent } from 'react';
import { useSessionStore } from '@/store/session.ts';
import { HS_URL } from '@/lib/matrix/config.ts';
import styles from './LoginScreen.module.css';

/**
 * Username/password login with a register toggle.
 * testids: login-form, login-username, login-password, login-submit, login-register-toggle, login-error
 */
export function LoginScreen() {
  const status = useSessionStore((s) => s.status);
  const error = useSessionStore((s) => s.error);
  const login = useSessionStore((s) => s.login);
  const register = useSessionStore((s) => s.register);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const busy = status === 'logging-in';

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    if (mode === 'login') void login(username, password);
    else void register(username, password);
  };

  return (
    <div className={styles.root}>
      <form className={styles.card} onSubmit={onSubmit} data-testid="login-form" noValidate>
        <div className={styles.logo} aria-hidden="true">
          A
        </div>
        <h1 className={styles.title}>{mode === 'login' ? 'Welcome back!' : 'Create an account'}</h1>
        <p className={styles.subtitle}>
          {mode === 'login' ? "We're so excited to see you again!" : 'Pick a username and password'}
        </p>

        <label className={styles.label} htmlFor="login-username">
          Username
        </label>
        <input
          id="login-username"
          className={styles.input}
          data-testid="login-username"
          autoComplete="username"
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy}
        />

        <label className={styles.label} htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          className={styles.input}
          data-testid="login-password"
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />

        {error && status !== 'logging-in' && (
          <div className={styles.error} data-testid="login-error" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className={styles.submit}
          data-testid="login-submit"
          disabled={busy || !username.trim() || !password}
        >
          {busy ? 'Please wait...' : mode === 'login' ? 'Log In' : 'Register'}
        </button>

        <div className={styles.footer}>
          {mode === 'login' ? 'Need an account?' : 'Already have an account?'}{' '}
          <button
            type="button"
            className={styles.link}
            data-testid="login-register-toggle"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            disabled={busy}
          >
            {mode === 'login' ? 'Register' : 'Log in'}
          </button>
        </div>
        <div className={styles.server}>Homeserver: {HS_URL}</div>
      </form>
    </div>
  );
}
