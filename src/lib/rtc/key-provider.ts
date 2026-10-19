/**
 * Phase 7: the bridge between matrix-js-sdk's per-participant media keys and livekit-client's frame encryptor.
 *
 * The SDK's `MatrixRTCSession` generates our sender key, ships it to every other member's device over Olm
 * (`m.call.encryption_keys` to-device messages) and emits `EncryptionKeyChanged(key, index, membership,
 * rtcBackendIdentity)` for every key it knows (ours included). livekit-client only ships `ExternalE2EEKeyProvider`,
 * which takes one shared passphrase; per-participant keys go through the protected `onSetEncryptionKey(cryptoKey,
 * participantIdentity, keyIndex)` of `BaseKeyProvider`, so this subclass exposes it (the same shape Element Call uses).
 * `sharedKey: false` makes the worker keep one keyring per participant identity.
 */
import { BaseKeyProvider } from 'livekit-client';

export class MatrixKeyProvider extends BaseKeyProvider {
  private readonly known = new Map<string, Set<number>>();

  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keyringSize: 16 });
  }

  /** Hand a raw 128-bit (or longer) key for `identity` at `index` to the worker (HKDF-derived there). */
  async setParticipantKey(key: Uint8Array, identity: string, index: number): Promise<void> {
    const material = await crypto.subtle.importKey('raw', key as BufferSource, 'HKDF', false, ['deriveBits', 'deriveKey']);
    this.onSetEncryptionKey(material, identity, index);
    let set = this.known.get(identity);
    if (!set) this.known.set(identity, (set = new Set()));
    set.add(index);
  }

  /** Whether at least one key for `identity` was set (the "can we hear them" signal). */
  hasKeyFor(identity: string): boolean {
    return (this.known.get(identity)?.size ?? 0) > 0;
  }

  identitiesWithKeys(): string[] {
    return [...this.known.keys()];
  }
}
