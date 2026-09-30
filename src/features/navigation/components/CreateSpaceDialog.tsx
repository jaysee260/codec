/**
 * DEV-A-8 create space. Opened from `space-add` on the rail. `createSpace` also creates the
 * `general` channel, so we only wait for the space and let the store auto-select its first child.
 * testids: create-space-dialog, create-space-name, create-space-submit, dialog-close
 */
import { useState } from 'react';
import { createSpace } from '@/lib/matrix/actions.ts';
import { useRoomStore, waitForRoom } from '@/store/rooms.ts';
import { showToast } from '@/store/toast.ts';
import { serverErrorText } from '../errors.ts';
import { Dialog, DialogField } from './Dialog.tsx';

export function CreateSpaceDialog({ onClose }: { onClose(): void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const spaceName = name.trim();
    if (!spaceName) return;
    setBusy(true);
    setError(null);
    try {
      const spaceId = await createSpace({ name: spaceName });
      await waitForRoom(spaceId);
      useRoomStore.getState().selectSpace(spaceId);
      showToast(`Created ${spaceName}`, 'success');
      onClose();
    } catch (e) {
      setError(serverErrorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      testId="create-space-dialog"
      title="Create a Space"
      description="Spaces group your channels, like a Discord server."
      error={error}
      submitLabel="Create"
      submitTestId="create-space-submit"
      submitDisabled={name.trim().length === 0}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <DialogField
        label="Space name"
        hint="A #general channel is created for you."
        testId="create-space-name"
        value={name}
        onChange={setName}
        placeholder="Design"
        maxLength={60}
      />
    </Dialog>
  );
}
