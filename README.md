# ◈ GhostMesh — BitChat, reimagined and advanced

Offline mesh chat. No servers, no phone number, no internet required.
Different from bitchat: **identity + tribes + Noise DMs + smart relay + radar + karma**.
Built **on real BitChat technology** (see §BitChat tech below), not a clone protocol.

> Professional stack pick (your question): **Expo (React Native) + TypeScript**.
> Why: one codebase ships to Android + iOS, BLE gives real advertise/scan like
> the original bitchat, Expo Go lets you test on a real phone in 30 seconds via
> QR (no Android Studio needed), OTA updates, and the same TypeScript protocol
> core runs on web for demo. Flutter would also work but needs the full SDK +
> Java toolchain.

## Try it NOW (no install)

Open **`web-demo/index.html`** in any browser (double-click it).
Companion simulator for the phone app, with 5 simulated BLE ghosts that relay
your messages with real hop counts, RSSI radar, karma, locked rooms
(real AES-256-GCM), burn-after-30s, bridge node, panic wipe, export.

## BitChat tech (real spec, ported from permissionlesstech/bitchat)

- **Radio**: official service UUID `F47B5E2D-…-4B5C` + characteristic
  `A1B2C3D4-…-4C5D`, no advertised name, dual role (central scan/connect +
  peripheral advertise/serve), 512B MTU (`src/protocol/radio.ts`, `ble.ts`)
- **Frames**: binary v1 packets — version/type/TTL/u64-timestamp/flags/u16-len,
  8B sender + optional 8B recipient, payload, optional 64B Ed25519
  (`encodePacket`/`decodePacket`; strict guards reject truncated/compressed/v2)
- **Identity** (§3): Curve25519 Noise static + Ed25519 signing key; peer ID =
  first 8B of `SHA-256(staticPub)`; self-certifying binary announces — the mesh
  engine verifies an announce against the key embedded in its own payload
- **DMs** (§5): `Noise_XX_25519_ChaChaPoly_SHA256` live sessions (mutual auth +
  forward secrecy, pure-TS ChaCha20-Poly1305) + `Noise_X` one-way courier seals
  for offline mail (`src/crypto/noise.ts`, `DmSessions` in `ghostCrypto.ts`)
- **Mesh rules** (§4): originate TTL 7, dense-graph (≥6 links) broadcast cap 5,
  signatures exclude TTL, noise-only padding to 256/512/1024/2048 buckets
- **GhostMesh extras** ride inside this framing: `(#tribe)`-tagged public posts,
  `GM1:` AES-locked rooms, karma, radar, 7-day outbox, burn messages, chunked
  files (type `0x22`), bridge uplink

### The radio, precisely (what is and is not possible from JS)

`react-native-ble-plx@3.5.1` — the BLE library in `package.json` — is
**central-only**: it has no advertiser and no GATT server (grep the package for
`advertis` and you only find scan-side parsing plus an `AlreadyAdvertising`
error code). A phone that cannot advertise cannot be discovered, so a mesh
cannot form on that library alone. GhostMesh therefore splits the radio:

| role | implementation | status |
|---|---|---|
| central: scan, connect, MTU, discover, monitor, write | `BleplxRadio` on real ble-plx APIs | done |
| peripheral: advertise + GATT server | `android/app/src/main/java/com/ghostmesh/app/radio/GhostMeshRadioModule.kt` via `NativePeripheralRadio` | **Kotlin written, not compiled here** |
| framing, fragmentation, reassembly, duty cycle, link budget | `src/protocol/ble.ts` (hardware-free) | done + unit-tested |
| iOS peripheral | — | not written; iOS runs central-only |

The Kotlin module is ~250 lines of standard `BluetoothLeAdvertiser` +
`BluetoothGattServer` and is registered in `MainApplication.kt`. It has **not
been compiled** — there is no JDK/Gradle/Android SDK in the environment it was
written in, so the first `expo run:android` / `eas build` is what actually
verifies it. If it fails to build, delete `android/app/src/main/java/com/ghostmesh/app/radio/`
and remove the `packages.add(GhostMeshRadioPackage())` line: everything else
falls back to central-only scanning, and the app still runs.

## Bridge nodes (far peers over the uplink)

Two phones that cannot hear each other can still talk through a bridge — a
tiny relay that stores and forwards **opaque** BitChat frames. It reads only
the 14-byte header (sender/recipient) to route; payloads are Noise-encrypted
(DMs) or AES-locked (rooms) and Ed25519-signed, so it can neither read nor
forge anything, and it rejects frames that lie about their sender.

```bash
npm run bridge                 # listens on 0.0.0.0:8787 (BRIDGE_PORT to change)
```

Point the app at it with `MeshSession.setBridgeUrl('https://your.host:8787')`.
This is optional: with no bridge URL the mesh is 100% BLE.

## Self-updates via GitHub (no EAS, no reinstall hassle)

The app checks `github.com/chahat1709/ghostmesh/releases/latest` on launch.
When a newer `v<versionCode>` tag exists, a green banner appears —
one tap downloads the APK and opens Android's installer. No PC needed.

Shipping an update (versionCode must rise every time):

```bash
# 0. one-time: set up release signing (never commit this file)
cp android/keystore.properties.template android/keystore.properties   # then edit it

# 1. bump: app.json version + android.versionCode, android/app/build.gradle versionCode/versionName
# 2. rebuild signed release (in android/):
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a        # Windows: .\gradlew.bat
# 3. publish (tag number MUST equal the new versionCode):
gh release create v4 --title "GhostMesh 1.0.3" --notes "..." path/to.apk
```

`src/updates/selfUpdate.ts` holds the whole client (check/download/install).

> **Two build fixes worth knowing about.** `android/gradle/wrapper/gradle-wrapper.properties`
> used to point at `file:///C:/Users/chaha/android/gradle-8.10.2-all.zip`, so
> `gradlew` only ever worked on one Windows machine — it now pulls the standard
> Gradle 8.10.2 distribution over HTTPS. And the release keystore password was
> committed in plaintext in `android/gradle.properties`; it now lives in the
> gitignored `android/keystore.properties`. **The old password is still in git
> history at `e035cf4` and the repo is public — rotate that key.** This matters
> more than usual here, because the self-updater installs APKs from GitHub
> releases and Android's only defence against a forged update is the signing
> identity.

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
| anon only, rotating nicks | stable dual-key identity (Noise static + Ed25519), restored across relaunches |
| password rooms (shared key) | kept, hardened: sha256-KDF → XSalsa20-Poly1305 (`GM1:` rooms). Wrong password = undecryptable |
| flood, TTL 7 / dense-cap 5 | same BitChat rules adopted verbatim, plus karma-weighted radar |
| session only | 7-day store-and-forward courier outbox, MMKV persistence, offline DMs flush on sight |
| peer list | proximity radar (real RSSI rings), hop map from TTL decay, karma relay reputation |
| plain chat | tribes `(#name)`, locked rooms, chunked files (0x22 fragments), burn msgs, panic wipe, export |
| BLE (+Nostr) | BLE per spec + bridge nodes (far peers over uplink when online) |

## Layout

```
app/index.tsx              main chat (tribes + composer + attach + burn + export + panic tap)
app/dm.tsx                 direct messages (Noise XX / courier, live session status)
app/radar.tsx              proximity radar (RSSI rings, hops, karma, radio roles)
app.json / eas.json        BLE permissions + APK build profile
src/protocol/bitchat.ts    official binary v1 codec + TTL rules + UUIDs
src/protocol/radio.ts      radio adapters: ble-plx central, native peripheral, loopback (tests)
src/protocol/ble.ts        BleTransport: dual role, duty cycle, link budget, 0x20 reassembly
src/protocol/meshEngine.ts dedupe / relay / store-forward / karma over BitChat frames
src/protocol/files.ts      chunked file transfer (type 0x22) + reassembly
src/protocol/bridge.ts     bridge client (opaque frame uplink)
src/protocol/b64.ts        base64 for Hermes + node + web
src/crypto/noise.ts        SHA-256 + ChaCha20-Poly1305 + Noise XX/X (dependency-free)
src/crypto/ghostCrypto.ts  dual-key identity + packet signing + tribe rooms + DmSessions
src/store/mesh.ts          MeshSession — wires identity, radio, DMs, outbox, files, bridge
src/store/meshBinding.ts   binds MeshSession to the zustand store
src/store/chatStore.ts     zustand state, persisted, with burn pruning
src/store/persist.ts       MMKV on device, in-memory elsewhere (one code path)
src/updates/selfUpdate.ts  GitHub-release APK self-updater
server/bridge.js           reference bridge relay (node, zero deps)
web-demo/index.html        zero-install companion simulator (simulated radio)
scripts/test-bitchat.js    11 interop tests against the real crypto/codec modules
scripts/test-core.js       11 mesh-rule tests against the real meshEngine
scripts/test-mesh.js       15 end-to-end groups: two live sessions over loopback radio
android/.../radio/         Kotlin peripheral BLE (advertiser + GATT server)
```

## Protocol (one paragraph)

Every frame is a BitChat v1 binary packet: `ver/type/TTL/u64-ts/flags/u16-len` +
8B sender [+ 8B recipient] + payload [+ 64B Ed25519, TTL-excluded].
Receivers drop truncated/compressed/v2 frames, `ttl 0`, seen
`SHA-256(sender|type|ts|payload)` keys and bad sigs (announces verify against
the key in their own payload); unknown-key traffic is relayed but not displayed;
the rest is delivered + relayed at TTL-1 after 20–60ms jitter (dense graphs
clamp broadcasts to 5). DMs run Noise XX sessions inside `noiseEncrypted`
packets; offline mail uses Noise X seals held in a 7-day outbox and flushed on
sight. Files split into type-`0x22` chunks sized so a signed packet still fits
one 512B write; frames that don't fit are re-fragmented as type-`0x20`.

## Self-test

```bash
npm test          # all three suites
# ✅ GhostMesh core: 11/11
# ✅ BitChat-tech: 11/11 interop tests pass
# ✅ GhostMesh end-to-end: 15/15 test groups pass
```

`scripts/test-mesh.js` is the one to read: it compiles the real TypeScript,
boots **two live `MeshSession`s**, joins them with in-process radios and checks
announce exchange, tribe routing, locked rooms, burn timers, a Noise X courier
DM upgrading to a Noise XX session, outbox queue→persist→relaunch→flush, file
reassembly, 0x20 fragmentation, a real HTTP bridge relay, persistence + panic
wipe, karma, peer expiry, signature rejection, duty cycle and link budget.
No hardware, no simulator — but the code paths are the ones the phone runs.

## Continuous integration

`ci/android-verify.yml` is a GitHub Actions workflow that runs `tsc`, all three
test suites, and `./gradlew :app:compileDebugKotlin` — the last one is the real
compile check on `GhostMeshRadioModule.kt`. It lives in `ci/` rather than
`.github/workflows/` because the agent that wrote it authenticates as a GitHub
App without the `workflows` permission, so it cannot create files there. Enable
it with:

```bash
mkdir -p .github/workflows
cp ci/android-verify.yml .github/workflows/verify.yml
git add -A && git commit -m "ci: verify" && git push
```

### What the tests do NOT prove

- **Nothing here has touched a real radio.** The peripheral Kotlin module has
  not been compiled — the sandbox has no JDK/Gradle/Android SDK and no way to
  fetch one (only the npm registry and api.github.com are reachable) — and no
  BLE has been put on air. Enable the workflow above, or run
  `cd android && ./gradlew :app:compileDebugKotlin` anywhere with the SDK.
  Either way, two phones in the same room is the only real test of the mesh.
- **iOS peripheral mode does not exist** — there is no `ios/` directory and no
  Swift counterpart, so iOS devices scan but cannot be discovered.
- The chat UI has not been driven by a UI test; it is exercised only through
  the `MeshSession` handlers the UI subscribes to.
