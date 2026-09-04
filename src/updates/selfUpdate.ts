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

/** Returns update info when the latest GitHub release is newer than us. Null = no update / offline / error. */
export async function checkForApkUpdate(currentBuildCode: string): Promise<ApkUpdate | null> {
  try {
    if (Platform.OS !== 'android') return null;
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const latest = tagToCode(String(j.tag_name ?? ''));
    const current = parseInt(String(currentBuildCode ?? ''), 10);
    if (!Number.isFinite(latest) || !Number.isFinite(current) || latest <= current) return null;
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
