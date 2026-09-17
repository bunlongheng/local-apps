#!/usr/bin/env node
// Per-file coverage floor: the aggregate gate protects the total, this protects one file.
//   node scripts/coverage-floor.js <lcov.info> <path-suffix> <min-lines%> <min-branches%>
//   node scripts/coverage-floor.js --run <path-suffix> <min-lines%> <min-branches%> <test files...>
// --run measures the file with node --test into a private temp dir (no shared /tmp path between
// concurrent runs), then applies the floor.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function floor(file, suffix, minLines, minBranches) {
  if (!fs.existsSync(file)) { console.error(`coverage-floor: no lcov report at ${file}`); return 2; }
  const records = fs.readFileSync(file, 'utf8').split('end_of_record');
  const rec = records.find((r) => (r.match(/^SF:(.*)$/m) || [])[1]?.endsWith(suffix));
  if (!rec) { console.error(`coverage-floor: no record for ${suffix} in ${file}`); return 2; }
  const num = (k) => Number((rec.match(new RegExp(`^${k}:(\\d+)$`, 'm')) || [])[1] || 0);
  const lines = (100 * num('LH')) / Math.max(1, num('LF')), branches = (100 * num('BRH')) / Math.max(1, num('BRF'));
  console.log(`coverage-floor: ${suffix} lines ${lines.toFixed(2)}% (min ${minLines}) branches ${branches.toFixed(2)}% (min ${minBranches})`);
  if (lines < Number(minLines) || branches < Number(minBranches)) { console.error('coverage-floor: below the floor'); return 1; }
  return 0;
}

function run(suffix, minLines, minBranches, tests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-floor-'));
  const out = path.join(dir, 'lcov.info');
  try {
    // Called from inside a test file, node:test would see its own NODE_TEST_CONTEXT and refuse to
    // run the nested suite; drop it so the child is a fresh runner.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${out}`, `--test-coverage-include=${suffix}`, ...tests], { stdio: ['ignore', 'ignore', 'inherit'], env });
    if (r.status !== 0) { console.error(`coverage-floor: node --test exited ${r.status}`); return r.status || 1; }
    return floor(out, suffix, minLines, minBranches);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const argv = process.argv.slice(2);
process.exit(argv[0] === '--run' ? run(argv[1], argv[2], argv[3], argv.slice(4)) : floor(argv[0], argv[1], argv[2], argv[3]));
