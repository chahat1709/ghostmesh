/**
 * Single MeshSession for the app, plus identity persistence.
 *
 * A relaunch used to mint a brand-new keypair every time, which meant your
 * peers saw a different ghost each launch and DM sessions could never resume.
 * The signing key stays in RAM; the identity envelope (nick/colour/peer id) is
 * what gets restored, so the app can rejoin as the same peer id.
 */
import { createIdentity, Identity } from '../crypto/ghostCrypto';
import { getKv } from './persist';
import { MeshSession } from './mesh';
import { b64decode, b64encode } from '../protocol/ble';

const K_IDENTITY = 'identity';

let session: MeshSession | null = null;

export function getSession(): MeshSession | null {
  return session;
}

export function setSession(s: MeshSession | null): void {
  session = s;
}

/** Persist the non-secret parts of an identity so a relaunch looks the same. */
export function saveIdentity(id: Identity): void {
  try {
    getKv().set(
      K_IDENTITY,
      JSON.stringify({ nick: id.nick, color: id.color, peerIdHex: id.peerIdHex })
    );
  } catch {}
}

export interface RestoredIdentity {
  nick: string;
  color: string;
  peerIdHex: string;
}

export function loadIdentity(): RestoredIdentity | null {
  try {
    const raw = getKv().get(K_IDENTITY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.peerIdHex !== 'string' || parsed.peerIdHex.length !== 16) return null;
    return parsed as RestoredIdentity;
  } catch {
    return null;
  }
}

export function forgetIdentity(): void {
  try {
    getKv().remove(K_IDENTITY);
  } catch {}
}

export { createIdentity, b64decode, b64encode };
