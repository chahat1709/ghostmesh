# ◈ GhostMesh — BitChat, reimagined and advanced

Offline mesh chat. No servers, no phone number, no internet required.
Different from bitchat: **identity + tribes + Noise DMs + smart relay + radar + karma**.
Now built **on real BitChat technology** (see §BitChat tech below), not a clone protocol.

> Professional stack pick (your question): **Expo (React Native) + TypeScript**.
> Why: one codebase ships to Android + iOS, Expo Go lets you test on a real phone
> in 30 seconds via QR (no Android Studio needed), OTA updates, and the same
> TypeScript protocol core runs on web for demo. The BLE itself is the imported
> `bitchat-android` link layer (Kotlin GATT server + client managers) bridged to
> TypeScript by `src/protocol/radio.ts` — advertising and scanning are the upstream
> implementation, not a re-write. Flutter would also work but needs the full SDK +
> Java toolchain this machine doesn't have.

## Try it NOW (no install)

Open **`web-demo/index.html`** in any browser (double-click it).
Companion simulator for the phone app, with 5 simulated BLE ghosts that relay
your messages with real hop counts, RSSI radar, karma, locked rooms
(real AES-256-GCM), burn-after-30s, bridge node, panic wipe, export.

## BitChat tech (real spec, ported from permissionlesstech/bitchat)

- **Radio**: official service UUID `F47B5E2D-…-4B5C` + characteristic
  `A1B2C3D4-…-4C5D`, no advertised name, simultaneous central + peripheral,
  512B MTU (`src/protocol/ble.ts`, `src/protocol/bitchat.ts`)
- **Frames**: binary v1 packets — version/type/TTL/u64-timestamp/flags/u16-len,
  8B sender + optional 8B recipient, payload, optional 64B Ed25519
  (`encodePacket`/`decodePacket`; strict guards reject truncated/compressed/v2)
- **Identity** (§3): Curve25519 Noise static + Ed25519 signing key; peer ID =
  first 8B of `SHA-256(staticPub)`; self-certifying binary announces
- **DMs** (§5): `Noise_XX_25519_ChaChaPoly_SHA256` live sessions (mutual auth +
  forward secrecy, pure-TS ChaCha20-Poly1305) + `Noise_X` one-way courier seals
  for offline mail (`src/crypto/noise.ts`, `DmSessions` in `ghostCrypto.ts`)
- **Mesh rules** (§4): originate TTL 7, dense-graph (≥6 links) broadcast cap 5,
  signatures exclude TTL, noise-only padding to 256/512/1024/2048 buckets
- **GhostMesh extras** ride inside this framing: `(#tribe)`-tagged public posts,
  `GM1:` AES-locked rooms, karma, radar, 7-day outbox, burn messages

Verify it: `npm run test:bit` → 11/11 interop tests pass
(SHA-256 vector, AEAD tamper, XX + X roundtrips, codec, TTL rules, reassembly).

## Self-updates via GitHub (no EAS, no reinstall hassle)

The app checks `github.com/chahat1709/ghostmesh/releases/latest` on launch.
When a newer release exists, a green banner appears — one tap downloads the APK
and opens Android's installer. No PC needed.

Tags are compared as **semver** (`v2.0.5` against the app's `1.0.6`); a bare
`v<number>` tag still falls back to comparing `versionCode`. It used to compute
`parseInt('2.0.5') === 2` against `versionCode 7`, so the banner never appeared
no matter what was published. `scripts/test-update.js` locks this down.

Shipping an update (versionCode must rise every time):

```bash
# 1. bump: app.json version + android.versionCode, android/app/build.gradle versionCode/versionName
# 2. rebuild signed release:
.\gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a   # in android/
# 3. publish (tag number MUST equal the new versionCode):
gh release create v3 --title "GhostMesh 1.0.2" --notes "..." path\to.apk
```

`src/updates/selfUpdate.ts` holds the whole client (check/download/install).

## Get the APK (install on Android)

No Android Studio needed — build runs in Expo's cloud (free tier works):

```bash
npm install -g eas-cli
eas login          # free Expo account
eas init           # links projectId into app.json (once)
npm run build:apk  # cloud build → download link + QR when done
```

Install the downloaded `.apk` on your phone (allow "unknown apps" once).
Note: real BLE mesh needs this native build — Expo Go can't include the
Bluetooth module, which is why the APK matters.

## Quick preview without APK (Expo Go, no BLE)

```bash
npm install
npx expo start
# scan the QR with Expo Go (Android) / Camera (iOS)
```

For store builds (real background BLE) you need a native build once:

```bash
npx expo run:android   # or: npx expo run:ios
```

## What makes it advanced vs bitchat

| bitchat | GhostMesh |
|---|---|
| anon only, rotating nicks | stable dual-key identity (Noise static + Ed25519), QR friend-add |
| password rooms (shared key) | kept, hardened: 10k-iteration SHA-256 KDF → NaCl secretbox (XSalsa20-Poly1305), `GM1:` rooms. Wrong password = undecryptable |
| flood, TTL 7 / dense-cap 5 | same BitChat rules adopted verbatim, plus karma-weighted radar |
| session only | 7-day store-and-forward outbox (persisted to MMKV), offline DMs flush on re-announce |
| peer list | proximity radar (signal rings), hop map, karma relay reputation |
| plain chat | tribes `(#name)`, locked rooms, chunked files (type `0x22`, indexed + reorder-tolerant), burn msgs, panic wipe |
| BLE (+Nostr) | BLE per spec + a bridge node you can run: `npm run bridge` (zero deps, `server/bridge.js`) |

## Layout

```
app/index.tsx              main chat (tribes + composer + export + panic tap)
app/radar.tsx              proximity radar; tap a peer to open a DM
app/dm.tsx                 DM thread: Noise XX + courier, burn toggle, 📎 file send
app.json / eas.json        BLE permissions + APK build profile
src/protocol/bitchat.ts    official binary v1 codec + TTL rules + UUIDs
src/protocol/meshEngine.ts dedupe / relay / store-forward / karma over BitChat frames
src/protocol/radio.ts      bridges the imported Kotlin link layer to the engine
src/protocol/ble.ts        base64 + MTU chunking helpers shared with the native side
src/protocol/files.ts      chunked file transfer (type 0x22): split, index, reassemble
src/protocol/bridge.ts     HTTP uplink client for bridge nodes
src/crypto/noise.ts        SHA-256 + ChaCha20-Poly1305 + Noise XX/X (dependency-free)
src/crypto/ghostCrypto.ts  dual-key identity + packet signing + tribe rooms + DmSessions
src/store/mesh.ts          MeshSession: DMs, files, outbox, burn, liveness, karma
src/store/meshBinding.ts   routes session events into the store
src/store/sessionHost.ts   session singleton + identity restore across relaunches
src/store/persist.ts       MMKV-backed kv, in-memory fallback off-device
src/store/chatStore.ts     zustand state, persisted + burn-aware
src/store/exportTranscript.ts  transcript formatting + share sheet
src/updates/selfUpdate.ts  GitHub-release APK updater
server/bridge.js           zero-dependency bridge node (`npm run bridge`)
ci/android-verify.yml      Kotlin compile + debug APK workflow (see below)
web-demo/index.html        zero-install companion simulator (simulated radio)
scripts/test-bitchat.js    11 interop tests against the real modules
scripts/test-core.js       18 groups against the real engine (relay/dedupe/karma/files)
scripts/test-mesh.js       21 end-to-end groups: two real sessions over two engines
scripts/test-update.js     6 groups on the release-tag comparison
```

## Protocol (one paragraph)

Every frame is a BitChat v1 binary packet: `ver/type/TTL/u64-ts/flags/u16-len` +
8B sender [+ 8B recipient] + payload [+ 64B Ed25519, TTL-excluded].
Receivers drop truncated/compressed/v2 frames, `ttl 0`, seen
`SHA-256(sender|type|ts|payload)` keys and bad sigs; unknown-key traffic is
relayed but not displayed; the rest is delivered + relayed at TTL-1 after
20–60ms jitter (dense graphs clamp broadcasts to 5). DMs run Noise XX sessions
inside `noiseEncrypted` packets; offline mail uses Noise X seals. Files split
into type-`0x20` fragments at the 512B MTU.

## Self-test

```bash
npm test
# ✅ GhostMesh core: 18/18 groups pass (relay, dedupe, signatures, karma, hops, outbox, files)
# ✅ BitChat-tech: 11/11 interop tests pass
# ✅ GhostMesh mesh: 21/21 groups pass (announce, courier DM, XX, outbox, files, burn, bridge, persistence, expiry, status, wipe, export)
# ✅ GhostMesh updater: 6/6 groups pass (semver parse, ordering, legacy tags, guards)
```

`test-core` and `test-mesh` compile the real TypeScript and exercise it —
`test-core` used to re-implement the relay rules in JavaScript, which proved
nothing about `meshEngine.ts`. `test-mesh` runs two `MeshSession`s on two
`MeshEngine`s wired the way `app/index.tsx` wires them (transport → the other
node's `receive`), so a DM, a handshake, a courier flush and a chunked file all
travel the real code path. No radio is involved: the link layer is injected,
exactly as the native module injects it on a phone.

## Bridge node

A bridge is the one node with internet. It moves opaque signed frames and can
read none of them.

```bash
npm run bridge            # 0.0.0.0:8787 (override with BRIDGE_PORT)
curl localhost:8787/health
```

It refuses frames whose declared sender is not the posting peer, so one client
cannot inject traffic as another ghost.

## Releasing a signed build

The keystore password is **not** in the repo. Copy
`android/keystore.properties.template` to `android/keystore.properties`
(gitignored) and fill it in; `android/app/build.gradle` reads it from there.

> The password committed earlier is still in git history (`e035cf4`). The
> self-updater installs APKs straight from GitHub releases, so the signing key
> is the security boundary — rotate it.

`ci/android-verify.yml` compiles the Kotlin link layer and assembles a debug
APK. It lives outside `.github/workflows/` because the automation token that
opens PRs here has no `workflows` scope; copy it across to enable it.

## Imported BitChat code (GPL-3.0)

`android/app/src/main/java/com/bitchat/android/` is imported verbatim from
`permissionlesstech/bitchat-android` (link layer, protocol codec, broadcaster,
tracker, power profiles), plus minimal local stubs
(`ui.debug.DebugStubs`, `services.AppStateStore`) and the RN bridge in
`com.ghostmesh.app.ble` that hosts their stack. Everything else (UI, TS mesh
decisions, Noise-TS, self-updater) is GhostMesh.

Because the imported code is **GPL-3.0**, this whole project is distributed
under GPL-3.0 — see LICENSE.md. Source is public here, which satisfies the
license as long as every APK release matches a published commit.
