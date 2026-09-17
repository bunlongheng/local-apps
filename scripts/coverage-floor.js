#!/usr/bin/env node
// Per-file coverage floor from an lcov report: the aggregate gate protects the total, this protects
// one file. Usage: node scripts/coverage-floor.js <lcov.info> <path-suffix> <min-lines%> <min-branches%>
const fs = require('fs');
const [file, suffix, minLines, minBranches] = process.argv.slice(2);
const records = fs.readFileSync(file, 'utf8').split('end_of_record');
const rec = records.find((r) => (r.match(/^SF:(.*)$/m) || [])[1]?.endsWith(suffix));
if (!rec) { console.error(`coverage-floor: no record for ${suffix} in ${file}`); process.exit(2); }
const num = (k) => Number((rec.match(new RegExp(`^${k}:(\\d+)$`, 'm')) || [])[1] || 0);
const lines = (100 * num('LH')) / Math.max(1, num('LF')), branches = (100 * num('BRH')) / Math.max(1, num('BRF'));
console.log(`coverage-floor: ${suffix} lines ${lines.toFixed(2)}% (min ${minLines}) branches ${branches.toFixed(2)}% (min ${minBranches})`);
if (lines < Number(minLines) || branches < Number(minBranches)) { console.error('coverage-floor: below the floor'); process.exit(1); }
