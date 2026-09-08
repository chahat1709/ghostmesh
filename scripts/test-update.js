// Self-updater comparison test — the tag/version comparison that decides
// whether an APK update is offered.
const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-update');

// selfUpdate.ts imports react-native only for Platform.OS; stub it so the pure
// comparison functions can run under node.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'react-native') return require.resolve('./rn-stub.js');
  return origResolve.call(this, request, ...rest);
};

execSync(
  `npx tsc "${path.join(ROOT, 'src', 'updates', 'selfUpdate.ts')}" --outDir "${OUT}" --module commonjs --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop --noImplicitAny false --strict false`,
  { cwd: ROOT, stdio: 'pipe' }
);

const { tagToCode, parseSemver, compareSemver, isNewerTag } = require(path.join(OUT, 'selfUpdate.js'));

let n = 0;
const ok = (name) => {
  n++;
  console.log(`  ✓ ${name}`);
};

assert.deepStrictEqual(parseSemver('v2.0.5'), [2, 0, 5], 'semver parsed');
assert.strictEqual(parseSemver('v7'), null, 'bare integer tag is not semver');
ok('parseSemver separates semver tags from legacy integer tags');

assert.strictEqual(compareSemver('v2.0.5', '1.0.6'), 1, '2.0.5 > 1.0.6');
assert.strictEqual(compareSemver('v1.0.6', '1.0.6'), 0, 'equal');
assert.strictEqual(compareSemver('v1.0.4', '1.0.6'), -1, 'older');
assert.strictEqual(compareSemver('v1.1.0', 'v1.0.9'), 1, 'minor bump wins');
ok('compareSemver orders major.minor.patch correctly');

// The bug: tag v2.0.5 with versionCode 7 must be recognised as newer.
assert.strictEqual(tagToCode('v2.0.5'), 2, 'the old parse collapsed 2.0.5 to 2');
assert.strictEqual(isNewerTag('v2.0.5', '7'), false, 'old behaviour: never updates');
assert.strictEqual(isNewerTag('v2.0.5', '7', '1.0.6'), true, 'with the app version it does');
ok('v2.0.5 over versionCode 7 is now offered as an update (was silently skipped)');

assert.strictEqual(isNewerTag('v1.0.6', '7', '1.0.6'), false, 'same version = no update');
assert.strictEqual(isNewerTag('v1.0.4', '7', '1.0.6'), false, 'older tag = no update');
ok('no update is offered for the same or an older tag');

assert.strictEqual(isNewerTag('v7', '6'), true, 'legacy integer tag still compares to versionCode');
assert.strictEqual(isNewerTag('v7', '7'), false, 'legacy tag equal = no update');
ok('legacy v<number> tags still compare against versionCode');

assert.strictEqual(isNewerTag('garbage', '7', '1.0.6'), false, 'unparseable tag = no update');
ok('an unparseable tag never triggers an update');

console.log(`\n✅ GhostMesh updater: ${n}/${n} groups pass (semver parse, ordering, legacy tags, guards)`);
