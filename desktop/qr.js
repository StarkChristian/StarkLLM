// The QR code of the phone link's pairing (Settings > Phone): the desktop app makes the code, the page only draws the
// squares it gets (no QR library and no network in the page). qrcode-generator: MIT, no dependencies.
const qrcode = require('qrcode-generator');

// text -> rows of booleans (true = dark), smallest version that fits, error correction M (15 %)
function qrMatrix(text) {
  const q = qrcode(0, 'M');
  q.addData(String(text), 'Byte');
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

module.exports = { qrMatrix };
