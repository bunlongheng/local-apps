// Pure parsers for launchd .plist XML. No fs / no side effects, so they can be
// unit-tested in isolation. Used by server.js to render the Loops automations.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function plistVal(xml, key, kind) {
  const re = new RegExp('<key>' + key + '</key>\\s*<' + kind + '>([^<]*)</' + kind + '>');
  const m = xml.match(re);
  return m ? m[1] : null;
}

// Parse a StartCalendarInterval block into a human schedule like "Fri 10:00".
// Returns null if the plist has no calendar block.
function calendarSchedule(xml) {
  const m = xml.match(/<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  if (!m) return null;
  const block = m[1];
  const wd = plistVal(block, 'Weekday', 'integer');
  const hr = plistVal(block, 'Hour', 'integer');
  const min = plistVal(block, 'Minute', 'integer');
  const day = wd != null ? (DOW[parseInt(wd, 10) % 7] || `wd${wd}`) : 'Daily';
  const hh = String(hr != null ? parseInt(hr, 10) : 0).padStart(2, '0');
  const mm = String(min != null ? parseInt(min, 10) : 0).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

module.exports = { DOW, plistVal, calendarSchedule };
