const test = require('node:test');
const assert = require('node:assert');
const { isChromeExtensionManifest, isChromeExtensionRepo } = require('../../lib/chrome-ext');

test('isChromeExtensionManifest: MV3 extension manifest', () => {
  assert.strictEqual(isChromeExtensionManifest('{"manifest_version":3,"name":"Capture"}'), true);
});

test('isChromeExtensionManifest: MV2 extension manifest', () => {
  assert.strictEqual(isChromeExtensionManifest('{"manifest_version":2,"name":"Old"}'), true);
});

test('isChromeExtensionManifest: PWA web app manifest is not an extension', () => {
  assert.strictEqual(isChromeExtensionManifest('{"name":"Forensic","icons":[],"start_url":"/"}'), false);
});

test('isChromeExtensionManifest: malformed JSON is not an extension', () => {
  assert.strictEqual(isChromeExtensionManifest('not json'), false);
});

test('isChromeExtensionManifest: string manifest_version is not trusted', () => {
  assert.strictEqual(isChromeExtensionManifest('{"manifest_version":"3"}'), false);
});

test('isChromeExtensionRepo: reads manifest.json at the repo root only', () => {
  const reads = [];
  const readFile = (p) => { reads.push(p); return '{"manifest_version":3}'; };
  assert.strictEqual(isChromeExtensionRepo('/Sites/capture', readFile), true);
  assert.deepStrictEqual(reads, ['/Sites/capture/manifest.json']);
});

test('isChromeExtensionRepo: missing manifest.json passes', () => {
  const readFile = () => { throw new Error('ENOENT'); };
  assert.strictEqual(isChromeExtensionRepo('/Sites/bheng', readFile), false);
});

test('isChromeExtensionRepo: no localPath passes', () => {
  assert.strictEqual(isChromeExtensionRepo(undefined), false);
  assert.strictEqual(isChromeExtensionRepo(''), false);
});
