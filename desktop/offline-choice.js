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
  },
  es: {
    title: 'StarkLLM',
    message: '¿Debe StarkLLM funcionar totalmente sin conexión?',
    detail: 'Totalmente sin conexión: StarkLLM no establece ninguna conexión con internet. Sin comprobación de actualizaciones, sin descargas, sin búsqueda web, sin proveedores de IA en línea; solo se usa el motor de IA de este PC.\n\n' +
      'El primer inicio necesita internet una vez para descargar el motor y un modelo de IA. Siga en línea por ahora y pase a totalmente sin conexión después, salvo que el motor y un modelo ya estén en este PC.\n\n' +
      'Puede cambiarlo en cualquier momento en Ajustes > Privacidad y red. Allí figura todo aquello con lo que StarkLLM se conecta.',
    online: 'Seguir en línea (recomendado para el primer inicio)',
    offline: 'Trabajar totalmente sin conexión'
  },
  fr: {
    title: 'StarkLLM',
    message: 'StarkLLM doit-il fonctionner entièrement hors ligne ?',
    detail: 'Entièrement hors ligne : StarkLLM n\'établit aucune connexion à Internet. Pas de recherche de mises à jour, pas de téléchargements, pas de recherche web, pas de fournisseurs d\'IA en ligne ; seul le moteur d\'IA de ce PC est utilisé.\n\n' +
      'Le premier démarrage a besoin d\'Internet une fois pour télécharger le moteur et un modèle d\'IA. Restez en ligne pour l\'instant et passez ensuite en mode entièrement hors ligne, sauf si le moteur et un modèle sont déjà sur ce PC.\n\n' +
      'Vous pouvez le modifier à tout moment dans Paramètres > Confidentialité et réseau. Tout ce à quoi StarkLLM se connecte y est listé.',
    online: 'Rester en ligne (recommandé pour le premier démarrage)',
    offline: 'Passer entièrement hors ligne'
  },
  it: {
    title: 'StarkLLM',
    message: 'StarkLLM deve funzionare completamente offline?',
    detail: 'Completamente offline: StarkLLM non stabilisce alcuna connessione a Internet. Nessun controllo degli aggiornamenti, nessun download, nessuna ricerca web, nessun fornitore di IA online; viene usato solo il motore di IA di questo PC.\n\n' +
      'Il primo avvio ha bisogno di Internet una volta per scaricare il motore e un modello di IA. Per ora resti online e passi a completamente offline dopo, a meno che il motore e un modello siano già su questo PC.\n\n' +
      'Può cambiarlo in qualsiasi momento in Impostazioni > Privacy e rete. Lì è elencato tutto ciò a cui StarkLLM si connette.',
    online: 'Restare online (consigliato per il primo avvio)',
    offline: 'Passare a completamente offline'
  },
  tr: {
    title: 'StarkLLM',
    message: 'StarkLLM tamamen çevrimdışı mı çalışsın?',
    detail: 'Tamamen çevrimdışı: StarkLLM internete hiçbir bağlantı kurmaz. Güncelleme denetimi, indirme, web araması ve çevrimiçi yapay zeka sağlayıcıları yoktur; yalnızca bu bilgisayardaki yapay zeka motoru kullanılır.\n\n' +
      'İlk başlatma, motoru ve bir yapay zeka modelini indirmek için internete bir kez ihtiyaç duyar. Şimdilik çevrimiçi kalın ve sonra tamamen çevrimdışına geçin; motor ve bir model zaten bu bilgisayardaysa hemen geçebilirsiniz.\n\n' +
      'Bunu istediğiniz zaman Ayarlar > Gizlilik ve ağ bölümünden değiştirebilirsiniz. StarkLLM\'in bağlandığı her şey orada listelenir.',
    online: 'Çevrimiçi kal (ilk başlatma için önerilir)',
    offline: 'Tamamen çevrimdışına geç'
  }
};

// The question is in the six interface languages (locale: the language of the interface or of the system).
// Returns true when the user was asked now, false when they had been asked before. Closing the dialog means "online".
// STARKLLM_ASK_OFFLINE=0 skips the question (administrators, tests and the smoke test of the installer, where nobody
// is there to answer): StarkLLM then stays online, as before, and asks at the next start without the variable.
async function askOfflineChoice({ dialog, guard, parent, locale = 'en', log = () => {}, env = process.env }) {
  if (guard.hasAsked() || env.STARKLLM_ASK_OFFLINE === '0') return false;
  const t = TEXTS[String(locale).toLowerCase().split(/[-_]/)[0]] || TEXTS.en;  // the language of the interface, else English
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
