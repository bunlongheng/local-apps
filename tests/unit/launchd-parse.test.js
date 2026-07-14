// Unit: pure plist parsers. No server, no fs. These back the Loops "schedule"
// column (e.g. "Fri 10:00") and interval lookups for launchd automations.
const { test } = require('node:test');
const assert = require('node:assert');
const { plistVal, calendarSchedule, DOW } = require('../../launchd-parse');

const CAL_XML = `<?xml version="1.0"?>
<plist><dict>
  <key>Label</key><string>com.local-apps.example</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>5</integer>
    <key>Hour</key><integer>10</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
</dict></plist>`;

const INTERVAL_XML = `<plist><dict>
  <key>Label</key><string>com.local-apps.sync-claude</string>
  <key>StartInterval</key><integer>600</integer>
</dict></plist>`;

test('plistVal reads a string value', () => {
  assert.equal(plistVal(CAL_XML, 'Label', 'string'), 'com.local-apps.example');
});

test('plistVal reads an integer value', () => {
  assert.equal(plistVal(INTERVAL_XML, 'StartInterval', 'integer'), '600');
});

test('plistVal returns null for a missing key', () => {
  assert.equal(plistVal(INTERVAL_XML, 'Nope', 'string'), null);
});

test('calendarSchedule formats Weekday/Hour/Minute as "Fri 10:00"', () => {
  assert.equal(calendarSchedule(CAL_XML), 'Fri 10:00');
});

test('calendarSchedule zero-pads hour and minute', () => {
  const xml = `<key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>5</integer>
  </dict>`;
  assert.equal(calendarSchedule(xml), 'Mon 09:05');
});

test('calendarSchedule with no Weekday -> "Daily"', () => {
  const xml = `<key>StartCalendarInterval</key><dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>30</integer>
  </dict>`;
  assert.equal(calendarSchedule(xml), 'Daily 03:30');
});

test('calendarSchedule returns null when there is no calendar block', () => {
  assert.equal(calendarSchedule(INTERVAL_XML), null);
});

test('Weekday 7 wraps to Sun (modulo 7)', () => {
  const xml = `<key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>7</integer>
    <key>Hour</key><integer>0</integer>
    <key>Minute</key><integer>0</integer>
  </dict>`;
  assert.equal(calendarSchedule(xml), 'Sun 00:00');
  assert.equal(DOW.length, 7);
});

test('calendarSchedule defaults missing Hour and Minute to 00:00', () => {
  const xml = `<key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>2</integer>
  </dict>`;
  assert.equal(calendarSchedule(xml), 'Tue 00:00');
});

test('calendarSchedule falls back to wdN for a weekday DOW cannot resolve', () => {
  const xml = `<key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>-1</integer>
    <key>Hour</key><integer>1</integer>
    <key>Minute</key><integer>2</integer>
  </dict>`;
  assert.equal(calendarSchedule(xml), 'wd-1 01:02');
});
