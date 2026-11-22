// The address bar of StarkLLM's browser window (webtask.js): back, forward, reload/stop, home, the address and what the
// running task does. It only asks the desktop app (webtask-bar-preload.js); it has no network and no Node.
const $ = (id) => document.getElementById(id);
const bar = window.starkllmBar;
let editing = false;
let words = {};

function show(s) {
  words = s.words || words;
  $('back').disabled = !s.canBack;
  $('forward').disabled = !s.canForward;
  $('back').title = words.back || '';
  $('forward').title = words.forward || '';
  $('home').title = words.home || '';
  $('reload').title = s.loading ? (words.stop || '') : (words.reload || '');
  $('reloadIcon').style.display = s.loading ? 'none' : '';
  $('stopIcon').style.display = s.loading ? '' : 'none';
  $('progress').classList.toggle('on', Boolean(s.loading));
  $('address').placeholder = words.placeholder || '';
  if (!editing) $('address').value = s.url && s.url !== 'about:blank' ? s.url : '';
  $('lock').classList.toggle('secure', /^https:/i.test(s.url || ''));
  const task = $('task');
  task.classList.toggle('on', Boolean(s.task));
  task.classList.toggle('paused', s.task === 'paused');
  $('taskText').textContent = s.task === 'paused' ? (words.paused || '') : s.task ? (words.working || '') : '';
  document.documentElement.lang = s.lang || 'en';
}

$('back').onclick = () => bar.go('back');
$('forward').onclick = () => bar.go('forward');
$('reload').onclick = () => bar.go($('stopIcon').style.display === '' ? 'stop' : 'reload');
$('home').onclick = () => bar.go('home');
$('address').addEventListener('focus', () => { editing = true; $('address').select(); });
$('address').addEventListener('blur', () => { editing = false; });
$('address').addEventListener('keydown', (e) => { if (e.key === 'Escape') { editing = false; $('address').blur(); bar.go('refresh'); } });
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('address').value.trim();
  if (!text) return;
  editing = false;
  $('address').blur();
  bar.open(text);
});
bar.onState(show);
bar.go('refresh');
