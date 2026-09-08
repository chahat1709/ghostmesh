// Self-updater — no EAS, no account, no PC needed after bootstrap.
// Flow: GitHub Release (made with `gh release create`) holds the signed APK.
// The app checks api.github.com for a newer tag, downloads it with
// expo-file-system, and fires Android's installer via expo-intent-launcher.
// Tag format: v<number> matching android.versionCode, e.g. v2.

import { Platform } from 'react-native';

const OWNER = 'chahat1709';
const REPO = 'ghostmesh';

export interface ApkUpdate {
  tag: string;
  url: string;
  notes: string;
  size: number;
}

export function tagToCode(tag: string): number {
  const n = parseInt(tag.trim().replace(/^v/i, ''), 10);
  return Number.isFinite(n) ? n : NaN;
}

/** `v2.0.5` -> [2, 0, 5]. Returns null when the tag is not semver-ish. */
export function parseSemver(tag: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(String(tag ?? '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 / 0 / 1. Non-semver inputs compare as 0 (unknown). */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Is `tag` newer than what is running?
 *
 * Semver tags (v2.0.5) are compared against the app version string; bare
 * integer tags (v7) are legacy versionCode tags and compare against the build
 * number. Comparing a semver tag against versionCode is what used to happen:
 * parseInt('2.0.5') === 2 <= 7, so no update was ever offered.
 */
export function isNewerTag(tag: string, currentBuildCode: string, currentVersion?: string): boolean {
  const clean = String(tag ?? '').trim();
  if (parseSemver(clean) && currentVersion && parseSemver(currentVersion)) {
    return compareSemver(clean, currentVersion) > 0;
  }
  const latest = tagToCode(clean);
  const current = parseInt(String(currentBuildCode ?? ''), 10);
  return Number.isFinite(latest) && Number.isFinite(current) && latest > current;
}

/** Returns update info when the latest GitHub release is newer than us. Null = no update / offline / error. */
export async function checkForApkUpdate(
  currentBuildCode: string,
  currentVersion?: string
): Promise<ApkUpdate | null> {
  try {
    if (Platform.OS !== 'android') return null;
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!isNewerTag(String(j.tag_name ?? ''), currentBuildCode, currentVersion)) return null;
    const apk = (j.assets ?? []).find((a: any) => typeof a?.name === 'string' && /\.apk$/i.test(a.name));
    if (!apk?.browser_download_url) return null;
    return { tag: String(j.tag_name), url: String(apk.browser_download_url), notes: String(j.body ?? ''), size: Number(apk.size ?? 0) };
  } catch {
    return null; // mesh works offline — updater must never break chat
  }
}

/** Download the APK (progress 0..1) then open Android's installer. */
export async function downloadAndInstall(url: string, onProgress?: (p: number) => void): Promise<void> {
  const FileSystem = require('expo-file-system');
  const IntentLauncher = require('expo-intent-launcher');
  const dest = (FileSystem.documentDirectory ?? FileSystem.cacheDirectory) + 'ghostmesh-update.apk';
  try {
    await FileSystem.deleteAsync(dest, { idempotent: true });
  } catch {}
  const dl = await FileSystem.downloadAsync(url, dest, {}, (ev: any) => {
    if (onProgress && ev?.totalBytesExpectedToWrite > 0) {
      onProgress(ev.totalBytesWritten / ev.totalBytesExpectedToWrite);
    }
  });
  const contentUri: string = await FileSystem.getContentUriAsync(dl.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  });
}
