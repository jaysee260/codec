/**
 * DEV-A-6 create channel. Opened from `channel-add` and `space-menu-create-channel`.
 * testids: create-channel-dialog, create-channel-name, create-channel-topic, create-channel-submit, dialog-close
 */
import { useState } from 'react';
import { createChannel } from '@/lib/matrix/actions.ts';
import { useRoomStore, waitForRoom } from '@/store/rooms.ts';
import { showToast } from '@/store/toast.ts';
import { serverErrorText } from '../errors.ts';
import { Dialog, DialogField } from './Dialog.tsx';

/** Discord channel names: lowercase, no whitespace (spaces become dashes). */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-');
}

export function CreateChannelDialog({ spaceId, onClose }: { spaceId: string; onClose(): void }) {
  const spaceName = useRoomStore((s) => s.roomsById[spaceId]?.name);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const channelName = slugify(name);
    if (!channelName) return;
    setBusy(true);
    setError(null);
    try {
      const roomId = await createChannel({ spaceId, name: channelName, topic: topic.trim() || undefined });
      await waitForRoom(roomId);
      useRoomStore.getState().selectRoom(roomId);
      showToast(`Created #${channelName}`, 'success');
      onClose();
    } catch (e) {
      setError(serverErrorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      testId="create-channel-dialog"
      title="Create Channel"
      description={spaceName ? `in ${spaceName}` : undefined}
      error={error}
      submitLabel="Create Channel"
      submitTestId="create-channel-submit"
      submitDisabled={slugify(name).length === 0}
      busy={busy}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <DialogField
        label="Channel name"
        testId="create-channel-name"
        value={name}
        onChange={(next) => setName(slugify(next))}
        placeholder="new-channel"
        prefix="#"
        maxLength={60}
      />
      <DialogField
        label="Topic (optional)"
        testId="create-channel-topic"
        value={topic}
        onChange={setTopic}
        placeholder="What is this channel about?"
        maxLength={200}
      />
    </Dialog>
  );
}
