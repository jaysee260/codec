/**
 * Error text helpers for the navigation dialogs.
 *
 * `describeError()` in the store is tuned for the login form (it rewrites M_FORBIDDEN to
 * "Invalid username or password"), but AC-A7-3 wants the *server's* message for a failed invite,
 * so these read `MatrixError.data.error` first and fall back to the message.
 */

interface MatrixErrorish {
  errcode?: string;
  httpStatus?: number;
  data?: { error?: string; errcode?: string };
  message?: string;
}

function asErrorish(e: unknown): MatrixErrorish | null {
  return e && typeof e === 'object' ? (e as MatrixErrorish) : null;
}

/** The homeserver's own error string when there is one, else a readable fallback. */
export function serverErrorText(e: unknown): string {
  const err = asErrorish(e);
  const fromServer = err?.data?.error;
  if (typeof fromServer === 'string' && fromServer.trim()) return fromServer.trim();
  if (e instanceof Error) {
    if (/failed to fetch|network/i.test(e.message)) return 'Cannot reach the homeserver';
    return e.message;
  }
  if (typeof err?.message === 'string' && err.message.trim()) return err.message.trim();
  return String(e);
}

/** Matrix error code, when the rejection is a MatrixError. */
export function errorCode(e: unknown): string | undefined {
  const err = asErrorish(e);
  return err?.errcode ?? err?.data?.errcode;
}

/**
 * True when an invite failed only because the user is already joined or already invited.
 * Inviting the same person twice must not look like a failure (QA re-runs against the same seed).
 */
export function isAlreadyMember(e: unknown): boolean {
  return /already (in the room|invited|a member)/i.test(serverErrorText(e));
}

/** Basic shape check so we can fail fast instead of round-tripping an obviously bad id. */
export function isUserId(value: string): boolean {
  return /^@[^\s:@]+:[^\s:@]+/.test(value.trim());
}
