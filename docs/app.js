'use strict';
const $ = id => document.getElementById(id);
let base = '', original = {}, current = {};

const log = (m, bad) => { const l = $('log'); l.textContent = `[${new Date().toLocaleTimeString()}] ${bad ? 'ERROR ' : ''}${m}\n` + l.textContent; };

async function api(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { log(e.message, true); } };

// ---- pairing ----
$('btnPair').onclick = guard(async () => {
  base = `http://127.0.0.1:${$('port').value.trim()}`;
  $('pairMsg').textContent = 'Connecting…';
  try {
    const s = await api('GET', '/status');
    $('conn').textContent = 'Helper: connected' + (s.mock ? ' (mock)' : '');
    $('conn').className = 'pill on';
    $('pairMsg').textContent = '';
    $('devs').hidden = false; $('cfg').hidden = false;
    log('Paired with helper' + (s.mock ? ' (mock mode)' : ''));
    loadPresets(); await scan();
  } catch (e) {
    $('pairMsg').textContent = e.message === 'Failed to fetch'
      ? 'Waiting for helper… run start-helper.bat and keep its window open (retrying automatically). If it is running, check that this site\'s origin is in helper-config.json.' : e.message;
  }
});

// auto-connect on load, and retry every 3s until the helper is running
(function autoConnect() {
  const tryOnce = async () => {
    if (!$('devs').hidden) return;
    try { $('btnPair').onclick(); } catch (_) {}
  };
  tryOnce();
  setInterval(tryOnce, 3000);
})();

// ---- WebHID detection (read-only) ----
$('btnHid').onclick = guard(async () => {
  if (!navigator.hid) throw new Error('WebHID not supported. Use Chrome or Edge.');
  const devs = await navigator.hid.requestDevice({ filters: [{ vendorId: 0x0c27 }, { vendorId: 0x19e5 }, { vendorId: 0x171b }] });
  $('hidOut').textContent = devs.length
    ? devs.map(d => `${d.productName || 'HID device'}  VID ${d.vendorId.toString(16).toUpperCase()}  PID ${d.productId.toString(16).toUpperCase()}`).join('\n')
    : 'No device selected.';
});

// ---- devices ----
async function scan() {
  const j = await api('POST', '/connect');
  const tb = $('devTable').tBodies[0]; tb.innerHTML = ''; $('devSel').innerHTML = '';
  j.devices.forEach(d => {
    tb.insertAdjacentHTML('beforeend', `<tr><td>${d.index}</td><td>${esc(d.part)}</td><td>${esc(d.firmware)}</td><td>${d.luid}</td><td>${esc(d.vidpid)}</td></tr>`);
    $('devSel').insertAdjacentHTML('beforeend', `<option value="${d.index}">#${d.index} ${esc(d.part)}</option>`);
  });
  log(`Found ${j.devices.length} reader(s)`);
  if (j.devices.length) await loadSettings();
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const idx = () => ($('devSel').value === '' ? undefined : Number($('devSel').value));
$('btnScan').onclick = guard(scan);
$('devSel').onchange = guard(async () => { await api('POST', '/select', { index: idx() }); await loadSettings(); });
$('btnBeep').onclick = guard(async () => { await api('POST', '/beep', { count: 1 }); log('Beep sent'); });
$('btnId').onclick = guard(async () => { const j = await api('GET', '/cardid'); $('info').textContent = `Card: ${j.hex || '(none)'}  (${j.bits} bits)`; });
$('btnFw').onclick = guard(async () => { $('info').textContent = JSON.stringify(await api('GET', '/firmware'), null, 1); });

// ---- tabs ----
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== 't-' + b.dataset.t);
});

// ---- presets & files ----
async function loadPresets() {
  try {
    const m = await (await fetch('presets/manifest.json')).json();
    $('presetSel').innerHTML = m.map(p => `<option value="${esc(p.file)}">${esc(p.label)}${p.template ? ' (template)' : ''}</option>`).join('');
  } catch (e) { log('Could not load presets: ' + e.message, true); }
}
function confirmWrite(what) { return confirm(`This will overwrite the configuration stored on the selected reader with ${what}. Continue?`); }
async function program(content, name) {
  if (!confirmWrite(name)) return;
  const j = await api('POST', '/hwg/import', { content, index: idx(), secure: false });
  log(`Programmed reader with ${name} (read=${j.readResult}, write=${j.writeResult})`);
  setSettings(j.settings);
}
$('btnPreset').onclick = guard(async () => {
  const f = $('presetSel').value; if (!f) return;
  const t = await (await fetch('presets/' + encodeURIComponent(f))).text();
  await program(t, f);
});
$('btnFile').onclick = guard(async () => {
  const f = $('file').files[0]; if (!f) throw new Error('Choose a file first');
  await program(await f.text(), f.name);
});
$('btnExport').onclick = guard(async () => {
  const j = await api('GET', '/hwg/export');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([j.content], { type: 'text/plain' }));
  a.download = 'reader-config.hwg'; a.click(); URL.revokeObjectURL(a.href);
  log('Exported current reader configuration');
});

// ---- settings ----
function setSettings(s) { original = { ...s }; current = { ...s }; renderGrid(); }
async function loadSettings() { setSettings((await api('GET', '/settings')).settings); log('Read settings from reader'); }
function renderGrid() {
  const f = $('filter').value.toLowerCase();
  $('grid').innerHTML = Object.keys(current).filter(k => k.toLowerCase().includes(f)).map(k =>
    `<label class="${current[k] !== original[k] ? 'chg' : ''}"><span title="${esc(k)}">${esc(k)}</span><input type="number" data-k="${esc(k)}" value="${current[k]}"></label>`).join('');
  $('grid').querySelectorAll('input').forEach(i => i.oninput = () => { current[i.dataset.k] = Number(i.value); i.parentElement.classList.toggle('chg', current[i.dataset.k] !== original[i.dataset.k]); });
}
$('filter').oninput = renderGrid;
$('btnRead').onclick = guard(loadSettings);
$('btnWrite').onclick = guard(async () => {
  const changed = Object.fromEntries(Object.entries(current).filter(([k, v]) => v !== original[k]));
  if (!Object.keys(changed).length) return log('No changes to write');
  if (!confirmWrite(`${Object.keys(changed).length} changed setting(s)`)) return;
  const j = await api('POST', '/settings', { settings: changed });
  log(`Wrote ${j.applied.join(', ')}`); setSettings(j.settings);
});

// ---- defaults ----
$('btnSaveUser').onclick = guard(async () => { if (confirm('Save current configuration as the reader\'s user defaults?')) { await api('POST', '/defaults', { action: 'saveUser', confirm: 'YES' }); log('Saved user defaults'); } });
$('btnFactory').onclick = guard(async () => { if (confirm('Reset this reader to FACTORY defaults? This cannot be undone.')) { await api('POST', '/defaults', { action: 'factory', confirm: 'YES' }); log('Factory defaults restored'); await loadSettings(); } });
