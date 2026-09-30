/**
 * DEV-A-9 new DM. Opened from `dm-new`. `createDm` reuses the room recorded in `m.direct`, so
 * running this twice for the same user lands on the same conversation (AC-A9-1).
 * testids: new-dm-dialog, new-dm-user-id, new-dm-submit, dialog-close
 */
import { useState } from 'react';
import { createDm } from '@/lib/matrix/actions.ts';
import { useRoomStore, waitForRoom } from '@/store/rooms.ts';
import { isUserId, serverErrorText } from '../errors.ts';
import { resolveUserName } from '../userLookup.ts';
import { Dialog, DialogField } from './Dialog.tsx';

/** `m.direct` account data can land a beat after the room itself; wait so the item shows in `dm-list`. */
function waitForDmListing(roomId: string, timeoutMs = 6000): Promise<void> {
  if (useRoomStore.getState().dms.some((d) => d.roomId === roomId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    const unsubscribe = useRoomStore.subscribe((s) => {
      if (s.dms.some((d) => d.roomId === roomId)) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

export function NewDmDialog({ onClose }: { onClose(): void }) {
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const target = userId.trim();
    if (!target) return;
    if (!isUserId(target)) {
      setError(`"${target}" is not a user ID. Use the full form, e.g. @dave:localhost`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolveUserName(target);
      const roomId = await createDm(target);
      await waitForRoom(roomId);
      await waitForDmListing(roomId);
      useRoomStore.getState().selectRoom(roomId);
      onClose();
    } catch (e) {
      setError(serverErrorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      testId="new-dm-dialog"
      title="Start a conversation"
      description="Direct messages are private between the two of you."
      error={error}
      submitLabel="Start"
      submitTestId="new-dm-submit"
      submitDisabled={userId.trim().length < 2}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <DialogField
        label="User ID"
        testId="new-dm-user-id"
        value={userId}
        onChange={setUserId}
        placeholder="@dave:localhost"
        maxLength={255}
      />
    </Dialog>
  );
}
