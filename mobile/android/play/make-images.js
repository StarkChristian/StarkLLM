// Store images for Google Play: 9:16 phone screenshots with a caption, and the 1024x500 feature graphic, per language.
const { chromium } = require('playwright');
const fs = require('fs');
const SITE = process.env.HOME + '/My_projects/StarkLLM/scenario-test/work/site-tour';
const SHOTS = process.env.HOME + '/nightbuild/tour/shots';
const OUT = process.env.HOME + '/nightbuild/play/img';
fs.mkdirSync(OUT, { recursive: true });
const b64 = f => fs.readFileSync(f).toString('base64');
const fonts = `@font-face{font-family:G;src:url(data:font/woff2;base64,${b64(SITE + '/src/assets/fonts/geist-latin-wght-normal.woff2')}) format('woff2');font-weight:100 900}
@font-face{font-family:GX;src:url(data:font/woff2;base64,${b64(SITE + '/dist/_astro/geist-latin-ext-wght-normal.DC-KSUi6.woff2')}) format('woff2');font-weight:100 900}`;
const icon = 'data:image/png;base64,' + b64(SITE + '/public/assets/icon-512.png');

const C = {
  chat: {
    en: ['Ask your documents', 'The answer comes from your PC, with its sources.'],
    de: ['Fragen Sie Ihre Dokumente', 'Die Antwort kommt von Ihrem PC, mit Quellen.'],
    es: ['Pregunta a tus documentos', 'La respuesta llega de tu PC, con sus fuentes.'],
    fr: ['Interrogez vos documents', 'La réponse vient de votre PC, avec ses sources.'],
    it: ['Interroga i tuoi documenti', 'La risposta arriva dal tuo PC, con le fonti.'],
    tr: ['Belgelerinizi sorun', 'Yanıt, kaynaklarıyla birlikte bilgisayarınızdan gelir.'] },
  deadlines: {
    en: ['Never miss a deadline', 'Overdue, today, this week and later.'],
    de: ['Keine Frist verpassen', 'Überfällig, heute, diese Woche und später.'],
    es: ['No se te pasa ningún plazo', 'Vencidos, hoy, esta semana y más adelante.'],
    fr: ['Aucune échéance oubliée', 'En retard, aujourd’hui, cette semaine et plus tard.'],
    it: ['Nessuna scadenza dimenticata', 'Scadute, oggi, questa settimana e più avanti.'],
    tr: ['Hiçbir son tarihi kaçırmayın', 'Gecikmiş, bugün, bu hafta ve daha sonra.'] },
  home: {
    en: ['Everything at a glance', 'The next deadlines and the new documents.'],
    de: ['Alles auf einen Blick', 'Die nächsten Fristen und die neuen Dokumente.'],
    es: ['Todo de un vistazo', 'Los próximos plazos y los documentos nuevos.'],
    fr: ['Tout en un coup d’œil', 'Les prochaines échéances et les nouveaux documents.'],
    it: ['Tutto a colpo d’occhio', 'Le prossime scadenze e i nuovi documenti.'],
    tr: ['Her şey bir bakışta', 'Yaklaşan son tarihler ve yeni belgeler.'] },
  add: {
    en: ['Send a letter to your PC', 'Photo, picture or file: your PC reads it.'],
    de: ['Briefe an den PC senden', 'Foto, Bild oder Datei: Ihr PC liest es.'],
    es: ['Envía cartas a tu PC', 'Foto, imagen o archivo: tu PC lo lee.'],
    fr: ['Envoyez un courrier au PC', 'Photo, image ou fichier : votre PC le lit.'],
    it: ['Invia lettere al tuo PC', 'Foto, immagine o file: lo legge il tuo PC.'],
    tr: ['Mektupları bilgisayara gönderin', 'Fotoğraf, görsel ya da dosya: bilgisayarınız okur.'] },
  pc: {
    en: ['Your documents stay home', 'Home Wi-Fi only, encrypted, no cloud.'],
    de: ['Ihre Dokumente bleiben zu Hause', 'Nur im Heimnetz, verschlüsselt, ohne Cloud.'],
    es: ['Tus documentos se quedan en casa', 'Solo en la red de casa, cifrado, sin nube.'],
    fr: ['Vos documents restent chez vous', 'Réseau de la maison, chiffré, sans cloud.'],
    it: ['I tuoi documenti restano a casa', 'Solo rete di casa, cifrato, senza cloud.'],
    tr: ['Belgeleriniz evde kalır', 'Yalnızca ev ağı, şifreli, bulut yok.'] },
};
const ORDER = [['chat', 'phone-2-chat'], ['deadlines', 'phone-3-deadlines'], ['home', 'phone-1-home'], ['add', 'phone-5-add'], ['pc', 'phone-4-pc']];
const FG = {
  en: 'Ask your documents from your phone. They stay on your PC.',
  de: 'Fragen Sie Ihre Dokumente vom Handy. Sie bleiben auf Ihrem PC.',
  es: 'Pregunta a tus documentos desde el móvil. Se quedan en tu PC.',
  fr: 'Interrogez vos documents depuis le téléphone. Ils restent sur votre PC.',
  it: 'Interroga i tuoi documenti dal telefono. Restano sul tuo PC.',
  tr: 'Belgelerinizi telefondan sorun. Bilgisayarınızda kalırlar.',
};
const css = `${fonts}*{margin:0;box-sizing:border-box}body{font-family:G,GX,sans-serif;color:#f2eefb;background:#07060b;
background-image:radial-gradient(900px 700px at 15% 0%,rgba(140,20,252,.38),transparent 70%),radial-gradient(700px 600px at 100% 100%,rgba(212,175,55,.14),transparent 70%);overflow:hidden}`;

(async () => {
  const br = await chromium.launch({ executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome' });
  const pg = await br.newPage({ viewport: { width: 1080, height: 1920 } });
  for (const l of Object.keys(FG)) {
    let n = 0;
    for (const [k, shot] of ORDER) {
      const [h, s] = C[k][l];
      const img = 'data:image/png;base64,' + b64(`${SHOTS}/${l}-${shot}.png`);
      await pg.setViewportSize({ width: 1080, height: 1920 });
      await pg.setContent(`<html><head><style>${css}
        .w{height:1920px;display:flex;flex-direction:column;align-items:center;padding:110px 70px 0}
        h1{font-size:74px;font-weight:700;text-wrap:balance;letter-spacing:-.02em;text-align:center;line-height:1.08}
        p{font-size:40px;color:#c9c2df;text-align:center;margin-top:26px;line-height:1.3}
        .f{margin-top:70px;flex:1;display:flex;align-items:flex-start;justify-content:center}
        .f img{max-width:780px;max-height:1430px;border-radius:46px;border:3px solid #272238;box-shadow:0 30px 90px rgba(0,0,0,.6),0 0 0 12px #100e18}
      </style></head><body><div class=w><h1>${h}</h1><p>${s}</p><div class=f><img src="${img}"></div></div></body></html>`);
      await pg.evaluate(() => document.fonts.ready);
      await pg.screenshot({ path: `${OUT}/${l}-${++n}-${k}.jpg`, type: 'jpeg', quality: 90 });
    }
    await pg.setViewportSize({ width: 1024, height: 500 });
    await pg.setContent(`<html><head><style>${css}
      .w{height:500px;display:flex;align-items:center;gap:56px;padding:0 70px}
      .w img{width:230px;height:230px;border-radius:52px;box-shadow:0 20px 60px rgba(140,20,252,.45)}
      h1{font-size:86px;font-weight:700;letter-spacing:-.03em}
      h1 span{color:#b777ff}
      p{font-size:34px;color:#c9c2df;margin-top:16px;line-height:1.3;max-width:600px}
      .t{font-size:24px;color:#d4af37;margin-top:22px;letter-spacing:.04em}
    </style></head><body><div class=w><img src="${icon}"><div><h1>Stark<span>LLM</span></h1><p>${FG[l]}</p><div class=t>Android · Windows</div></div></div></body></html>`);
    await pg.evaluate(() => document.fonts.ready);
    await pg.screenshot({ path: `${OUT}/${l}-feature.jpg`, type: 'jpeg', quality: 92 });
  }
  await br.close();
  console.log('done');
})();
