/**
 * Pre-flight check for the invite / new-DM dialogs.
 *
 * Synapse happily accepts an invite for a local user id that does not exist (HTTP 200), so the
 * "unknown user" case of AC-A7-3 only surfaces if we ask the homeserver about the profile first:
 * `GET /_matrix/client/v3/profile/{userId}` answers 404 for an unknown id. That also stops the room
 * from collecting phantom invites.
 */
import { getClient, getClientOrNull } from '@/lib/matrix/client.ts';
import { serverNameOf } from '@/lib/matrix/config.ts';

interface Httpish {
  httpStatus?: number;
}

/**
 * Resolve a user's display name, or throw with the homeserver's verdict when the id is unknown.
 * Failures other than 404 (offline, federation, ...) are ignored so the invite can still be tried.
 */
export async function resolveUserName(userId: string): Promise<string | undefined> {
  try {
    const profile = await getClient().getProfileInfo(userId);
    return profile.displayname ?? undefined;
  } catch (e) {
    if ((e as Httpish)?.httpStatus === 404) {
      throw new Error(`${userId} was not found on this homeserver`);
    }
    return undefined;
  }
}

/** Server name for example user ids in hints: the logged-in user's own server ("localhost" before login). */
export function exampleServer(): string {
  const me = getClientOrNull()?.getUserId();
  return me ? serverNameOf(me) : 'localhost';
}
