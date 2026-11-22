// The QR code of the phone link's pairing (Settings > Phone): the desktop app makes the code, the page only draws the
// squares it gets (no QR library and no network in the page). qrcode-generator: MIT, no dependencies.
const qrcode = require('qrcode-generator');

// text -> rows of booleans (true = dark), smallest version that fits, error correction L (7 %): a code on a screen has
// no stains, and L gives fewer and larger squares, which phone cameras read at once (M needed several tries)
function qrMatrix(text) {
  const q = qrcode(0, 'L');
  q.addData(String(text), 'Byte');
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

module.exports = { qrMatrix };
