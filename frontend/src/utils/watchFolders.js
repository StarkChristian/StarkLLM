// Settings > Letters from a folder (backend: services/watch_service.py). The engine notes why a file could not be
// imported as "<kind>: <detail>" (too_large, unreadable, import, move); the page shows a translated sentence for the
// kind and the technical detail after it.
export const ERROR_KINDS = ['too_large', 'unreadable', 'import', 'move'];

export function parseImportError(error) {
  const text = String(error || '').trim();
  if (!text) return null;
  const m = text.match(/^([a-z_]+):\s*([\s\S]*)$/);
  if (m && ERROR_KINDS.includes(m[1])) return { kind: m[1], detail: m[2].trim() };
  return { kind: 'other', detail: text };
}

// The answers of the engine to adding a folder that the page can say in the user's language
export const ADD_ERRORS = [
  'Please enter the full path of a folder on this PC.',
  'This folder was not found on this PC.',
  "This is StarkLLM's own data folder. Please choose another folder.",
  'This folder is watched already.',
];
