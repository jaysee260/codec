/**
 * DEV-A-7 invite to a space. Opened from `space-menu-invite`. Invites the user to the space *and*
 * to every joined child channel so they show up under `member-section-invited` (AC-A7-2).
 * Errors from the homeserver are shown verbatim in `invite-error` and the dialog stays open (AC-A7-3).
 * testids: invite-dialog, invite-user-id, invite-submit, invite-error, dialog-close
 */
import { useState } from 'react';
import { inviteUser } from '@/lib/matrix/actions.ts';
import { useRoomStore } from '@/store/rooms.ts';
import { showToast } from '@/store/toast.ts';
import { isAlreadyMember, isUserId, serverErrorText } from '../errors.ts';
import { exampleServer, resolveUserName } from '../userLookup.ts';
import { Dialog, DialogField } from './Dialog.tsx';

export function InviteDialog({ spaceId, onClose }: { spaceId: string; onClose(): void }) {
  const space = useRoomStore((s) => s.roomsById[spaceId]);
  const channels = useRoomStore((s) => s.channelsBySpace[spaceId]) ?? [];
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const target = userId.trim();
    if (!target) return;
    if (!isUserId(target)) {
      setError(`"${target}" is not a user ID. Use the full form, e.g. @carol:${exampleServer()}`);
      return;
    }
    setBusy(true);
    setError(null);

    // Synapse accepts invites for user ids that do not exist, so ask about the profile first.
    let displayName: string | undefined;
    try {
      displayName = await resolveUserName(target);
    } catch (e) {
      setError(serverErrorText(e));
      setBusy(false);
      return;
    }

    // Invite to the space first: if that fails, nothing else is attempted.
    const invite = async (roomId: string): Promise<unknown> => {
      try {
        await inviteUser(roomId, target);
        return null;
      } catch (e) {
        return isAlreadyMember(e) ? null : e;
      }
    };

    const spaceFailure = await invite(spaceId);
    if (spaceFailure) {
      setError(serverErrorText(spaceFailure));
      setBusy(false);
      return;
    }

    const failures: unknown[] = [];
    for (const channel of channels) {
      const failure = await invite(channel.roomId);
      if (failure) failures.push(failure);
    }
    if (failures.length > 0) {
      setError(serverErrorText(failures[0]));
      setBusy(false);
      return;
    }

    showToast(`Invited ${displayName ?? target} to ${space?.name ?? 'the space'}`, 'success');
    onClose();
  };

  return (
    <Dialog
      testId="invite-dialog"
      title="Invite people"
      description={space?.name ? `to ${space.name} and its channels` : undefined}
      error={error}
      errorTestId="invite-error"
      submitLabel="Invite"
      submitTestId="invite-submit"
      submitDisabled={userId.trim().length < 2}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <DialogField
        label="User ID"
        hint={channels.length > 0 ? `Also invited to ${channels.map((c) => `#${c.name}`).join(', ')}` : undefined}
        testId="invite-user-id"
        value={userId}
        onChange={setUserId}
        placeholder={`@carol:${exampleServer()}`}
        maxLength={255}
      />
    </Dialog>
  );
}
