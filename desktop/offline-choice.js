// First start: ask once whether StarkLLM should be fully offline (roadmap phase 3). The default is online: the first
// start needs the internet once, to download the engine and an AI model. The choice can be changed at any time in
// Settings > Privacy & network and in the tray menu. No Electron here: dialog and guard are passed in, for tests.

const TEXTS = {
  en: {
    title: 'StarkLLM',
    message: 'Should StarkLLM be fully offline?',
    detail: 'Fully offline: StarkLLM makes no connection to the internet at all. No update check, no downloads, no web search, no online AI providers; only the AI engine on this PC is used.\n\n' +
      'The first start needs the internet once to download the engine and an AI model. Stay online for now and switch to fully offline afterwards, unless the engine and a model are already on this PC.\n\n' +
      'You can change this at any time in Settings > Privacy & network. Everything StarkLLM connects to is listed there.',
    online: 'Stay online (recommended for the first start)',
    offline: 'Go fully offline'
  },
  de: {
    title: 'StarkLLM',
    message: 'Soll StarkLLM vollständig offline arbeiten?',
    detail: 'Vollständig offline: StarkLLM baut überhaupt keine Verbindung zum Internet auf. Keine Update-Prüfung, keine Downloads, keine Websuche, keine Online-KI-Anbieter; es wird nur die KI-Engine auf diesem PC genutzt.\n\n' +
      'Der erste Start braucht einmal das Internet, um die Engine und ein KI-Modell herunterzuladen. Bleiben Sie zunächst online und schalten Sie danach auf vollständig offline um, außer die Engine und ein Modell sind schon auf diesem PC.\n\n' +
      'Sie können das jederzeit unter Einstellungen > Datenschutz & Netzwerk ändern. Dort steht auch alles, womit sich StarkLLM verbindet.',
    online: 'Online bleiben (für den ersten Start empfohlen)',
    offline: 'Vollständig offline'
  }
};

// Returns true when the user was asked now, false when they had been asked before. Closing the dialog means "online".
async function askOfflineChoice({ dialog, guard, parent, locale = 'en', log = () => {} }) {
  if (guard.hasAsked()) return false;
  const t = TEXTS[String(locale).toLowerCase().startsWith('de') ? 'de' : 'en'];
  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: t.title,
    message: t.message,
    detail: t.detail,
    buttons: [t.online, t.offline],
    defaultId: 0,
    cancelId: 0
  });
  guard.setOffline(response === 1);
  guard.markAsked();
  log(`first start: the user chose ${response === 1 ? 'fully offline' : 'to stay online'}`);
  return true;
}

module.exports = { askOfflineChoice, TEXTS };
