import React, { useEffect } from 'react';
import { Stack } from 'expo-router';
import * as Updates from 'expo-updates';

// Silent OTA: on launch, fetch any published JS update and apply it on next
// start. Native changes (BLE libs, permissions, SDK) still need a fresh APK.
async function applyOtaQuietly() {
  try {
    if (__DEV__) return;
    const res = await Updates.checkForUpdateAsync();
    if (res.isAvailable) {
      await Updates.fetchUpdateAsync();
      await Updates.reloadAsync();
    }
  } catch {
    // offline / no update service configured yet — mesh still works
  }
}

export default function Layout() {
  useEffect(() => {
    void applyOtaQuietly();
  }, []);
  return <Stack screenOptions={{ headerStyle: { backgroundColor: '#0b0b12' }, headerTintColor: '#fff' }}>
    <Stack.Screen name="index" options={{ title: 'GhostMesh' }} />
    <Stack.Screen name="radar" options={{ title: 'Proximity radar' }} />
  </Stack>;
}
