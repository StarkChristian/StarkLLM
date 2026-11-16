// Is a folder synced to a cloud service? On many new Windows 11 PCs "Documents" is in OneDrive, so the knowledge base
// folder there is uploaded to Microsoft without the user noticing. StarkLLM keeps documents on the PC; the knowledge
// base page says so when its folder is synced.
const path = require('path');

const SERVICES = [
  ['OneDrive', /(^|[\\/])OneDrive( - [^\\/]+)?([\\/]|$)/i],
  ['Dropbox', /(^|[\\/])Dropbox([\\/]|$)/i],
  ['Google Drive', /(^|[\\/])(Google Drive|GoogleDrive|My Drive|Meine Ablage)([\\/]|$)/i],
  ['iCloud Drive', /(^|[\\/])(iCloudDrive|iCloud Drive|Mobile Documents)([\\/]|$)/i],
];

function cloudSync(folder, env = process.env) {
  if (!folder) return null;
  const norm = path.resolve(folder).toLowerCase();
  // OneDrive tells where it is; the folder can be named anything ("OneDrive - Firma GmbH")
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[key];
    if (root && (norm === path.resolve(root).toLowerCase() || norm.startsWith(path.resolve(root).toLowerCase() + path.sep))) {
      return 'OneDrive';
    }
  }
  for (const [name, pattern] of SERVICES) {
    if (pattern.test(folder)) return name;
  }
  return null;
}

module.exports = { cloudSync };
