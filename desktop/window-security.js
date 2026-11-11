// What the app window may open and which page may use the desktop bridge (roadmap phase 0, "secure Electron").
// The bridge (preload) hands out the local session token: a foreign page that got it could read every document.
// So only StarkLLM's own page (same origin, not just the same text prefix) may use it, links to other sites open in
// the user's browser, and the window never navigates away from the app.

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function sameOrigin(url, appUrl) {
  const a = originOf(url);
  return !!a && a !== 'null' && a === originOf(appUrl);
}

function isWebLink(url) {
  return /^https?:\/\//i.test(url || '');
}

// Permissions a page may get: only the app's own page, and only what StarkLLM uses (microphone for voice input,
// writing to the clipboard, full screen). Electron grants everything to every page unless told otherwise.
const APP_PERMISSIONS = new Set(['media', 'clipboard-sanitized-write', 'fullscreen']);

function permissionAllowed(permission, requestingUrl, appUrl, details = {}) {
  if (!sameOrigin(requestingUrl, appUrl) || !APP_PERMISSIONS.has(permission)) return false;
  if (permission === 'media' && Array.isArray(details.mediaTypes) && details.mediaTypes.some((t) => t !== 'audio')) {
    return false; // voice input needs the microphone, never the camera
  }
  return true;
}

module.exports = { sameOrigin, isWebLink, permissionAllowed, originOf };
