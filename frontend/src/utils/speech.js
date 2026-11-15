// Speech: which language a text is in (to pick a voice and the browser's speech language), and which installed voice
// speaks it. Plain word lists, no library; a text that is not clearly in one of these languages is read in the
// fallback language (the interface language), never guessed.
// To teach it another language add an entry to WORDS (and LETTERS); the voices come from the backend (/voice/voices).

const WORDS = {
  de: 'ich du er sie es wir ihr mein dein sein unser der die das den dem des ein eine einen einem einer eines ist sind war waren wird werden wurde wurden haben hat hatte kann können muss müssen soll sollen und nicht oder aber auch wenn dann dass weil mit von zu auf bei nach seit für hier dort bitte danke dank vielen ja nein doch hallo heute immer jetzt schon sehr wie was wer wo warum',
  en: 'the of to and a in is it you that he was for on are as with his they i at be this have from or one had by word but not what all were we when your can said there use an each which she do how their if would about who get go me my them youre theyre please thanks',
  fr: 'je tu il elle nous vous ils le la les un une des du de et ou mais ne pas est sont était ont que qui quoi quand comment pourquoi où dans sur avec pour par au aux ce cette ces mon ma mes votre vos bonjour merci oui non très veuillez avant après montant',
  es: 'yo tú él ella usted nosotros el la los las un una unos unas y o pero no es son fue han que qué quién cuándo cómo por dónde cuánto en con para del al este esta mi mis su sus hola gracias sí muy',
  it: 'io tu lui lei noi voi loro il lo la gli le un uno una dei delle della di da e ma non è sono era hanno che chi cosa quando come perché dove quanto nel nella con per tra questo questa mio mia ciao grazie sì molto',
  tr: 've bir bu şu için ile ama veya de da ki mi mı mu mü ne nasıl neden nerede kaç hangi kim ben sen biz siz onlar benim senin bizim sizin çok daha gibi kadar merhaba teşekkürler evet hayır',
};
// letters that point to a language (each hit counts double)
const LETTERS = {
  de: /[äöüß]/g,
  fr: /[éèêàâçùûîôœ]/g,
  es: /[ñ¿¡áíóú]/g,
  it: /[àèìòù]/g,
  tr: /[çğışöü]/g,
};
const SETS = Object.fromEntries(Object.entries(WORDS).map(([code, list]) => [code, new Set(list.split(' '))]));

/** The language code of a text ("de"), or null when it is not clear (short text, a mix, none of the known languages). */
export function detectLanguage(text) {
  const lower = String(text || '').toLowerCase();
  const tokens = lower.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const scores = {};
  for (const [code, set] of Object.entries(SETS)) {
    let score = tokens.filter((tok) => set.has(tok)).length;
    if (LETTERS[code]) score += 2 * (lower.match(LETTERS[code]) || []).length;
    if (score) scores[code] = score;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return null;
  const [best, second] = ranked;
  if (second && best[1] < second[1] * 1.5) return null;
  // the share of words that belong to the language must be real, else it is a name or a code in a foreign sentence
  const hits = tokens.filter((tok) => SETS[best[0]].has(tok)).length;
  return best[1] >= 2 && (hits / tokens.length >= 0.2 || (lower.match(LETTERS[best[0]]) || []).length) ? best[0] : null;
}

const REGIONS = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', tr: 'tr-TR', pt: 'pt-PT', nl: 'nl-NL', pl: 'pl-PL' };

/** The language tag for the browser's speech (utterance.lang): the text's language, else the fallback. */
export function speechLanguage(text, fallback = 'en') {
  const code = detectLanguage(text) || fallback;
  return REGIONS[code] || code;
}

/** The id of the installed voice for a text ("de_DE-thorsten-medium"), or null for the server's default voice. */
export function pickVoice(voices, text, fallback = 'en') {
  const code = detectLanguage(text) || fallback;
  return (voices || []).find((v) => v.language === code)?.id || null;
}
