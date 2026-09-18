#!/usr/bin/env node
// Per-file coverage floor: the aggregate gate protects the total, this protects one file.
//   node scripts/coverage-floor.js <lcov.info> <path-suffix> <min-lines%> <min-branches%>
//   node scripts/coverage-floor.js --run <path-suffix> <min-lines%> <min-branches%> <test files...>
//   node scripts/coverage-floor.js --all <min-lines%> <min-branches%> <include-glob> <test files...>
//   node scripts/coverage-floor.js --check <lcov.info> <min-lines%> <min-branches%>   (judge an existing report, every file)
// --run measures one file with node --test into a private temp dir (no shared /tmp path between
// concurrent runs), then applies the floor. --all measures every file the glob includes and fails on
// the first one under the floor: the aggregate gate protects the total, this protects each file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function parse(rec) {
  const num = (k) => Number((rec.match(new RegExp(`^${k}:(\\d+)$`, 'm')) || [])[1] || 0);
  return { file: (rec.match(/^SF:(.*)$/m) || [])[1], lines: (100 * num('LH')) / Math.max(1, num('LF')), branches: (100 * num('BRH')) / Math.max(1, num('BRF')) };
}

function floorAll(file, minLines, minBranches) {
  if (!fs.existsSync(file)) { console.error(`coverage-floor: no lcov report at ${file}`); return 2; }
  const recs = fs.readFileSync(file, 'utf8').split('end_of_record').filter((r) => /^SF:/m.test(r)).map(parse);
  if (!recs.length) { console.error('coverage-floor: no records'); return 2; }
  let bad = 0;
  for (const r of recs.sort((a, b) => a.lines - b.lines)) {
    const ok = r.lines >= Number(minLines) && r.branches >= Number(minBranches);
    if (!ok) bad++;
    console.log(`coverage-floor: ${ok ? 'ok  ' : 'LOW '} ${r.lines.toFixed(1).padStart(5)}% lines ${r.branches.toFixed(1).padStart(5)}% branches  ${r.file.replace(process.cwd() + '/', '')}`);
  }
  if (bad) { console.error(`coverage-floor: ${bad} file(s) under ${minLines}/${minBranches}`); return 1; }
  return 0;
}

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

function measure(include, tests, onReport) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-floor-'));
  const out = path.join(dir, 'lcov.info');
  try {
    // Called from inside a test file, node:test would see its own NODE_TEST_CONTEXT and refuse to
    // run the nested suite; drop it so the child is a fresh runner.
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-timeout=30000', '--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${out}`, '--test-reporter=spec', '--test-reporter-destination=stderr', `--test-coverage-include=${include}`, ...tests], { stdio: ['ignore', 'ignore', 'inherit'], env });
    if (r.status !== 0) { console.error(`coverage-floor: node --test exited ${r.status}`); return r.status || 1; }
    return onReport(out);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const argv = process.argv.slice(2);
if (argv[0] === '--run') process.exit(measure(argv[1], argv.slice(4), (out) => floor(out, argv[1], argv[2], argv[3])));
else if (argv[0] === '--all') process.exit(measure(argv[3], argv.slice(4), (out) => floorAll(out, argv[1], argv[2])));
else if (argv[0] === '--check') process.exit(floorAll(argv[1], argv[2], argv[3]));
else process.exit(floor(argv[0], argv[1], argv[2], argv[3]));
