// The knowledge base folder in a synced cloud folder (OneDrive on many Windows 11 PCs) is found.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { cloudSync } = require('../cloud-folder');

test('a folder inside the OneDrive the system names is found, whatever the folder is called', () => {
  const root = path.resolve('/Users/chris/OneDrive - Firma GmbH');
  assert.strictEqual(cloudSync(path.join(root, 'Dokumente', 'StarkLLM Knowledge Base'), { OneDriveCommercial: root }), 'OneDrive');
});

test('typical synced folders by name', () => {
  assert.strictEqual(cloudSync('C:\\Users\\chris\\OneDrive\\Documents\\StarkLLM Knowledge Base', {}), 'OneDrive');
  assert.strictEqual(cloudSync('/home/chris/Dropbox/StarkLLM Knowledge Base', {}), 'Dropbox');
  assert.strictEqual(cloudSync('G:\\My Drive\\StarkLLM Knowledge Base', {}), 'Google Drive');
  assert.strictEqual(cloudSync('C:\\Users\\chris\\iCloudDrive\\StarkLLM Knowledge Base', {}), 'iCloud Drive');
});

test('local folders are not', () => {
  assert.strictEqual(cloudSync('C:\\Users\\chris\\Documents\\StarkLLM Knowledge Base', {}), null);
  assert.strictEqual(cloudSync('/home/chris/Documents/OneDriveNotes/StarkLLM', {}), null);
  assert.strictEqual(cloudSync('', {}), null);
});
