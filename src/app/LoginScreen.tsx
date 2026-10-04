import { useState, type FormEvent } from 'react';
import { useSessionStore } from '@/store/session.ts';
import { DEFAULT_HS_URL, getHsUrl, hasHsUrlOverride, setHsUrl } from '@/lib/matrix/config.ts';
import styles from './LoginScreen.module.css';

/**
 * Username/password login with a register toggle and (Phase 2) an "Advanced" section holding the
 * homeserver URL, so a phone can point at the PC's LAN proxy (docs/MOBILE.md). The URL is persisted in
 * localStorage (`matrix-poc.hsUrl`) as it is typed and read by every Matrix call through `getHsUrl()`;
 * empty or equal to the build-time default removes the override.
 *
 * testids: login-form, login-username, login-password, login-submit, login-register-toggle, login-error,
 *          login-advanced-toggle, login-hs-url, login-hs-url-reset
 */
export function LoginScreen() {
  const status = useSessionStore((s) => s.status);
  const error = useSessionStore((s) => s.error);
  const login = useSessionStore((s) => s.login);
  const register = useSessionStore((s) => s.register);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(() => hasHsUrlOverride());
  const [hsUrl, setHsUrlInput] = useState(() => getHsUrl());
  const busy = status === 'logging-in';
  const overridden = hasHsUrlOverride();

  const onHsUrlChange = (value: string): void => {
    setHsUrlInput(value);
    setHsUrl(value); // persist as typed; getHsUrl() normalises on read
  };
  const onHsUrlBlur = (): void => {
    setHsUrlInput(getHsUrl()); // show the normalised, effective URL
  };
  const resetHsUrl = (): void => {
    setHsUrl(null);
    setHsUrlInput(DEFAULT_HS_URL);
  };

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    if (busy || !username.trim() || !password) return;
    setHsUrl(hsUrl);
    setHsUrlInput(getHsUrl());
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
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
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

        <div className={styles.advanced}>
          <button
            type="button"
            className={`${styles.advancedToggle} ${overridden ? styles.advancedToggleActive : ''}`}
            data-testid="login-advanced-toggle"
            aria-expanded={advancedOpen}
            aria-controls="login-advanced"
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            <span className={styles.chevron} aria-hidden="true">
              {advancedOpen ? '▾' : '▸'}
            </span>
            Advanced{overridden && !advancedOpen ? ' (custom homeserver)' : ''}
          </button>
          {advancedOpen && (
            <div id="login-advanced" className={styles.advancedBody}>
              <label className={styles.label} htmlFor="login-hs-url">
                Homeserver URL
              </label>
              <input
                id="login-hs-url"
                className={`${styles.input} ${styles.inputCompact}`}
                data-testid="login-hs-url"
                type="url"
                inputMode="url"
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={DEFAULT_HS_URL}
                value={hsUrl}
                onChange={(e) => onHsUrlChange(e.target.value)}
                onBlur={onHsUrlBlur}
                disabled={busy}
              />
              <div className={styles.hint}>
                On a phone, use the PC&apos;s address printed by <code>npm run hs:lan</code>, e.g.{' '}
                <code>http://192.168.1.20:8009</code>.
                {overridden && (
                  <>
                    {' '}
                    <button type="button" className={styles.link} data-testid="login-hs-url-reset" onClick={resetHsUrl} disabled={busy}>
                      Reset to default
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        <div className={styles.server} data-testid="login-hs-url-effective">
          Homeserver: {hsUrl || DEFAULT_HS_URL}
        </div>
      </form>
    </div>
  );
}
