import { t } from '../i18n';

// The desktop app reports why a web task or a step did not work in English (webtask-core.js, webtask.js): the known
// texts are shown in the user's language; others (for example from Ollama) stay as they are.
const KNOWN = [
  [/^The task took longer than (\d+) minutes and was ended\.$/, (m) => t('The task took longer than {minutes} minutes and was ended.', { minutes: m[1] })],
  [/^The AI model did not choose a step three times in a row\.$/, () => t('The AI model did not choose a step three times in a row.')],
  [/^The AI model repeated the same step without getting further\./, () => t('The AI model repeated the same step without getting further. Try a larger model or describe the task differently.')],
  [/^The site asked to check that a person is there \(CAPTCHA\)/, () => t('The site asked to check that a person is there (CAPTCHA). StarkLLM does not answer such checks; you did not either.')],
  [/^The AI model kept trying "(.*)", which the user did not allow, and was stopped\.$/, (m) => t('The AI model kept trying “{label}”, which you did not allow, and was stopped.', { label: m[1] })],
  [/^The AI model kept trying steps the user did not allow, and was stopped\.$/, () => t('The AI model kept trying steps you did not allow, and was stopped.')],
  [/^The AI model asked more than five times and was stopped\.$/, () => t('The AI model asked more than five times and was stopped.')],
  [/^The task was not finished in (\d+) steps\.$/, (m) => t('The task was not finished in {steps} steps.', { steps: m[1] })],
  [/^(\S+) was not opened because you did not allow it\.$/, (m) => t('{site} was not opened because you did not allow it.', { site: m[1] })],
  [/^the page did not answer$/, () => t('the page did not answer')],
  [/^the element is no longer on the page$/, () => t('the element is no longer on the page')],
  [/^the field is no longer on the page$/, () => t('the field is no longer on the page')],
  [/^the program could not start: (.*)$/, (m) => t('The program could not start: {detail}', { detail: m[1] })],
  [/^StarkLLM is fully offline: tool servers are off\.$/, () => t('StarkLLM is fully offline: tool servers are off.')],
];

export function webTaskErrorText(text) {
  const s = String(text || '');
  for (const [re, fn] of KNOWN) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return s;
}
