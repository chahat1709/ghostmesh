// Process-wide handle to the live mesh session, shared by the chat, DM and
// radar routes. Kept out of the zustand store on purpose: the session holds
// key material and timers, neither of which belongs in render state.

import { MeshSession } from './mesh';

let current: MeshSession | null = null;

export function setSession(s: MeshSession | null): void {
  current = s;
}

export function getSession(): MeshSession | null {
  return current;
}
