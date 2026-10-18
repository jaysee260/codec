/**
 * Phase 7: the LiveKit token exchange (MSC4195, legacy `/sfu/get` shape; see livekit-token.ts for why this one):
 * `client.getOpenIdToken()` -> `POST <livekit_service_url>/sfu/get { room, openid_token, device_id }` -> `{ url, jwt }`.
 */
import type { MatrixClient } from 'matrix-js-sdk';
import { buildLegacySfuRequest, type SfuResponse } from './livekit-token.ts';
import { CallError, type LivekitFocus } from './types.ts';

/** Describe a failed `/sfu/get` response for `CallError('token')` (pure, unit-tested). */
export function describeTokenFailure(status: number, body: unknown): string {
  const err = body && typeof body === 'object' ? (body as { errcode?: string; error?: string }) : {};
  if (status === 401) return 'The call server did not accept this session (OpenID token rejected)';
  if (status === 400) return `The call server rejected the request${err.error ? `: ${err.error}` : ''}`;
  if (status === 404) return 'The call server has no token endpoint at this URL (wrong livekit_service_url?)';
  if (status >= 500) return `The call server failed (${status}${err.error ? `: ${err.error}` : ''})`;
  return `The call server answered ${status}${err.error ? `: ${err.error}` : ''}`;
}

/** Validate the `{ url, jwt }` answer (pure). */
export function parseSfuResponse(body: unknown): SfuResponse {
  const b = body as Partial<SfuResponse> | null;
  if (!b || typeof b.url !== 'string' || typeof b.jwt !== 'string' || !b.url || !b.jwt) {
    throw new CallError('token', 'The call server returned no LiveKit url/jwt');
  }
  if (!/^wss?:\/\//i.test(b.url) && !/^https?:\/\//i.test(b.url)) throw new CallError('token', `The call server returned an invalid LiveKit url: ${b.url}`);
  return { url: b.url, jwt: b.jwt };
}

/**
 * Fetch a LiveKit token for `roomId` from the focus. Throws `CallError('token')` with a readable message.
 * `fetchImpl` is injectable for tests.
 */
export async function fetchSfuToken(
  client: Pick<MatrixClient, 'getOpenIdToken' | 'getDeviceId'>,
  focus: LivekitFocus,
  roomId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SfuResponse> {
  const deviceId = client.getDeviceId();
  if (!deviceId) throw new CallError('token', 'No device id for this session');
  let openid;
  try {
    openid = await client.getOpenIdToken();
  } catch (e) {
    throw new CallError('token', 'Could not get an OpenID token from the homeserver', { cause: e });
  }
  let res: Response;
  try {
    res = await fetchImpl(`${focus.livekit_service_url}/sfu/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLegacySfuRequest(roomId, openid, deviceId)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new CallError('token', `Cannot reach the call server at ${focus.livekit_service_url}`, { cause: e });
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new CallError('token', describeTokenFailure(res.status, body));
  return parseSfuResponse(body);
}
