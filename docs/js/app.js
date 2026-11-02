/* pcProx WebHID Portal — UI wiring. All device I/O goes through PCX.HidReader / PCX.SimReader. */
(function () {
  'use strict';
  const PCX = window.PCX;
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hx = n => '0x' + Number(n).toString(16).toUpperCase().padStart(2, '0');
  const asciiOf = bytes => Array.from(bytes, b => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.')).join('');

  const st = {
    reader: null, map: null,
    qrz: null, qsvText: '',
    readerVals: {}, targets: {},
    preset: null, snapshots: [], snapSeq: 0, selA: null, selB: null,
    plan: null, listening: false, pollTimer: null, lastPoll: 0, card: null,
  };

  // ---------- log ----------
  function log(msg, kind) {
    const l = $('log');
    const line = `[${new Date().toLocaleTimeString()}] ${kind === 'err' ? 'ERROR ' : kind === 'warn' ? 'WARN  ' : ''}${msg}\n`;
    l.textContent = line + l.textContent.slice(0, 60000);
  }
  const wire = (dir, bytes, id) => { if ($('chkWire').checked) log(`${dir} [id ${id}] ${PCX.toHex(bytes)}  |${asciiOf(bytes).replace(/\.+$/, '')}|`); };
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { log(e.message || String(e), 'err'); console.error(e); } };
  const need = () => { if (!st.reader) throw new Error('Connect a reader first'); return st.reader; };

  // ---------- environment ----------
  (function envCheck() {
    const w = [];
    if (!window.isSecureContext) w.push('This page is not in a secure context. WebHID needs https:// or http://localhost.');
    if (!PCX.HidReader.supported()) w.push('This browser does not support WebHID. Use a recent Chrome or Edge on desktop. The simulated reader still works.');
    if (w.length) { $('envWarn').innerHTML = w.map(esc).join('<br>'); $('envWarn').hidden = false; $('btnConnect').disabled = !PCX.HidReader.supported(); }
  })();

  // ---------- connect ----------
  async function attach(reader) {
    if (st.reader) await detach(true);
    const info = await reader.open();
    st.reader = reader;
    reader.on('tx', (b, id) => wire('TX', b, id));
    reader.on('rx', (b, id) => wire('RX', b, id));
    reader.on('input', (b, id) => onInputReport(b, id));
    st.map = PCX.loadMap(reader.vidpid);
    st.qrz = null; st.readerVals = {}; st.targets = {}; st.plan = null; st.snapshots = []; st.selA = st.selB = null;

    $('diName').textContent = reader.name;
    $('diVidPid').textContent = reader.vidpid;
    $('diModel').textContent = reader.kind === 'sim' ? 'Simulator (illustrative data only)' : PCX.modelName(reader.vid, reader.pid);
    $('diCols').innerHTML = reader.describe().map(c =>
      `<div><code>page ${hx(c.usagePage)} usage ${hx(c.usage)}</code> ${c.usagePage >= 0xFF00 ? '<span class="tag ok">vendor</span>' : ''} ` +
      `<span class="muted small">feature ${c.feature.map(f => `#${f.id}:${f.bytes}B`).join(', ') || '—'} · input ${c.input.map(f => `#${f.id}:${f.bytes}B`).join(', ') || '—'}</span></div>`).join('') || '<span class="muted">none reported</span>';
    $('selReportId').value = String(info.reportId);
    if (![...$('selReportId').options].some(o => o.value === String(info.reportId))) $('selReportId').insertAdjacentHTML('beforeend', `<option>${info.reportId}</option>`);
    $('selReportId').value = String(info.reportId);
    $('inReportLen').value = reader.reportLen;
    $('diReportNote').textContent = info.found ? 'from the HID descriptor' : 'no feature report in descriptor — using defaults';
    $('devInfo').hidden = false;
    $('secReader').hidden = false; $('secConfig').hidden = false;
    $('btnDisconnect').disabled = false; $('btnForget').disabled = reader.kind === 'sim';
    $('btnSimTap').hidden = reader.kind !== 'sim';
    $('conn').textContent = reader.kind === 'sim' ? 'Simulated reader' : `Connected · ${reader.name}`;
    $('conn').className = 'pill ' + (reader.kind === 'sim' ? 'sim' : 'on');
    applyTiming();
    renderMapUi(); renderSettings(); renderSnaps(); renderDiff(); renderQrz(); $('planBox').hidden = true;
    log(`Connected: ${reader.name} ${reader.vidpid} · report id ${reader.reportId}, ${reader.reportLen}-byte data`);
    if (!reader.hasVendorCollection()) log('No vendor-defined collection reported. If commands fail, switch the reader out of keyboard-wedge mode.', 'warn');
    if (st.map.fields.length) log(`Loaded field map for ${reader.vidpid}: ${st.map.fields.length} field(s)`);
  }
  async function detach(silent) {
    stopListening();
    const r = st.reader; st.reader = null;
    if (r) { try { await r.close(); } catch (_) {} }
    $('devInfo').hidden = true; $('secReader').hidden = true; $('secConfig').hidden = true;
    $('btnDisconnect').disabled = true; $('btnForget').disabled = true;
    $('conn').textContent = 'No reader'; $('conn').className = 'pill off';
    if (!silent) log('Disconnected');
  }

  $('btnConnect').onclick = guard(async () => {
    const devs = await PCX.HidReader.request();
    if (!devs.length) return log('No device selected');
    await attach(new PCX.HidReader(devs[0]));
  });
  $('btnSim').onclick = guard(() => attach(new PCX.SimReader()));
  $('btnDisconnect').onclick = guard(() => detach());
  $('btnForget').onclick = guard(async () => {
    const r = st.reader; if (!r || r.kind === 'sim') return;
    if (!confirm('Revoke this site\'s permission for the reader?')) return;
    await detach(true); await r.forget(); log('Device permission revoked');
  });
  if (PCX.HidReader.supported()) {
    navigator.hid.addEventListener('disconnect', e => { if (st.reader && st.reader.device === e.device) { log('Reader unplugged', 'warn'); detach(true); } });
    navigator.hid.addEventListener('connect', guard(async e => { if (!st.reader && PCX.VENDOR_IDS.includes(e.device.vendorId)) { log('Previously allowed reader plugged in'); await attach(new PCX.HidReader(e.device)); } }));
    // Reconnect to a reader this site was already granted (no picker needed).
    PCX.HidReader.granted().then(d => d.length && attach(new PCX.HidReader(d[0]))).catch(e => log(e.message, 'err'));
  }
  $('selReportId').onchange = () => { if (st.reader) { st.reader.reportId = Number($('selReportId').value); log(`Report id set to ${st.reader.reportId}`); } };
  $('inReportLen').onchange = () => { if (st.reader) { const n = Math.max(8, Math.min(24, Number($('inReportLen').value) || 24)); st.reader.reportLen = n; $('inReportLen').value = n; log(`Report data length set to ${n}`); } };

  // ---------- queries ----------
  async function query(cmd) {
    const r = need();
    const res = await r.command(cmd);
    const p = PCX.parseQueryReply(res.text, cmd);
    if (!p.ok) throw new Error(p.error);
    log(`${cmd} → ${res.text}${p.bytes ? ` (${p.bytes.length} bytes)` : ''}`);
    if (p.oddNibble) log(`${cmd} payload had an odd number of hex digits; last nibble dropped`, 'warn');
    return { ...p, text: res.text };
  }
  const showReader = (title, p) => {
    const ascii = p.bytes && p.bytes.length ? asciiOf(p.bytes) : '';
    $('readerOut').textContent = `${title}\nreply : ${p.text}\nhex   : ${p.bytes ? PCX.toHex(p.bytes) : '—'}${ascii ? `\nascii : ${ascii}` : ''}`;
  };
  $('btnVersion').onclick = guard(async () => { const p = await query('QSV'); st.qsvText = p.bytes ? asciiOf(p.bytes) : p.text; showReader('Version / service (QSV)', p); });
  $('btnUptime').onclick = guard(async () => showReader('Uptime / status (QUP)', await query('QUP')));
  $('btnDevData').onclick = guard(async () => showReader('Device data (QDD)', await query('QDD')));
  const beep = long => guard(async () => {
    const cmd = PCX.beepCommand($(long ? 'selBeepL' : 'selBeepS').value, long);
    const res = await need().command(cmd, { pollReads: 2 });
    log(`${cmd} sent${res.text ? ` → ${res.text}` : ''}`);
  });
  $('btnBeepS').onclick = beep(false);
  $('btnBeepL').onclick = beep(true);

  // ---------- card reading ----------
  const setting = (k, dflt) => st.targets[k] ?? st.readerVals[k] ?? dflt;
  function onInputReport(bytes) { if (st.listening) handleCard(bytes, 'input'); }
  function handleCard(bytes, src) {
    const now = performance.now();
    const { bits, idBytes } = PCX.extractCardId(bytes, st.map.layout);
    const hold = Number(setting('iIDHoldTO', 1000)) || 1000;
    const empty = !idBytes.length || idBytes.every(b => b === 0);
    if (empty) { if (st.card && now - st.card.seen >= hold) st.card = null; return; }
    const key = PCX.toHex(idBytes, '');
    if (st.card && st.card.key === key && now - st.card.seen < hold) { st.card.seen = now; return; }
    st.card = { key, seen: now };
    let v = PCX.bytesToBigInt(idBytes, false);
    if (bits && bits <= idBytes.length * 8) v &= (1n << BigInt(bits)) - 1n;
    let split = '—';
    if (bits && bits <= 64) {
      const s = PCX.splitWiegand(v, bits, Number(setting('iLeadParityBitCnt', 1)), Number(setting('iTrailParityBitCnt', 1)), Number(setting('iIDBitCnt', 16)));
      if (s) split = `${s.fac} / ${s.id}`;
    }
    const tb = $('cardTable').tBodies[0];
    tb.insertAdjacentHTML('afterbegin', `<tr><td>${new Date().toLocaleTimeString()}</td><td>${bits ?? '?'}</td><td class="mono">${esc(v.toString(16).toUpperCase())}</td><td class="mono">${v}</td><td class="mono">${split}</td></tr>`);
    while (tb.rows.length > 50) tb.deleteRow(-1);
    log(`Card (${src}): ${bits ?? '?'} bits, ${v.toString(16).toUpperCase()} · raw ${PCX.toHex(bytes)}`);
  }
  function startListening() {
    st.listening = true; $('btnCardListen').textContent = 'Stop listening';
    const cmd = (st.map.pollCommand || '').trim();
    if (cmd) {
      st.pollTimer = setInterval(async () => {
        const now = performance.now();
        if (!st.reader || now - st.lastPoll < PCX.POLL_THROTTLE_MS) return;
        st.lastPoll = now;
        try { const res = await st.reader.command(cmd, { pollReads: 1 }); if (res.raws[0]) handleCard(res.raws[0], 'poll'); }
        catch (e) { log(`Poll ${cmd}: ${e.message}`, 'err'); stopListening(); }
      }, 50);
    }
    log(`Listening for cards${cmd ? ` (polling ${cmd} every ≥${PCX.POLL_THROTTLE_MS} ms)` : ' (input reports)'}`);
  }
  function stopListening() {
    if (st.pollTimer) clearInterval(st.pollTimer);
    st.pollTimer = null;
    if (st.listening) log('Stopped listening');
    st.listening = false; $('btnCardListen').textContent = 'Start listening';
  }
  $('btnCardListen').onclick = () => (st.listening ? stopListening() : startListening());
  $('btnCardClear').onclick = () => { $('cardTable').tBodies[0].innerHTML = ''; st.card = null; };
  $('btnSimTap').onclick = () => {
    if (!st.listening) startListening();
    st.reader.tap(Math.floor(Math.random() * 255), Math.floor(Math.random() * 65535));
  };

  // ---------- tabs ----------
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.tab').forEach(t => t.hidden = t.id !== 't-' + b.dataset.t);
  });

  // ---------- settings ----------
  const fieldsFor = k => st.map ? st.map.fields.filter(f => f.key === k && f.cmd === 'QRZ') : [];
  function recomputeReaderVals() {
    st.readerVals = {};
    if (!st.qrz) return;
    for (const f of st.map.fields) {
      if (f.cmd !== 'QRZ') continue;
      const v = PCX.extractField(st.qrz, f);
      if (v !== undefined) st.readerVals[f.key] = v;
    }
  }
  async function readConfig() {
    const p = await query('QRZ');
    st.qrz = p.bytes;
    recomputeReaderVals();
    for (const [k, v] of Object.entries(st.readerVals)) if (!(k in st.targets)) st.targets[k] = v;
    renderQrz(); renderSettings(); renderPreset();
    $('planBox').hidden = true; st.plan = null;
    log(`Read configuration: ${st.qrz.length} bytes, ${Object.keys(st.readerVals).length} mapped setting(s)`);
  }
  $('btnReadCfg').onclick = guard(readConfig);

  function renderQrz() {
    $('qrzView').hidden = !st.qrz;
    if (!st.qrz) return;
    $('qrzLen').textContent = `${st.qrz.length} bytes`;
    const mapped = new Map();
    for (const f of st.map.fields) if (f.cmd === 'QRZ') for (let i = 0; i < f.width; i++) mapped.set(f.byte + i, (mapped.get(f.byte + i) || []).concat(f.key));
    $('qrzBytes').innerHTML = Array.from(st.qrz, (b, i) => {
      const m = mapped.get(i);
      return `<div class="byte ${m ? 'mapped' : ''} ${i < 5 ? 'conf' : ''}" title="${esc(m ? m.join(', ') : i < 5 ? 'confirmed decode' : 'unmapped')}"><i>${i}</i>${PCX.hex2(b)}</div>`;
    }).join('');
    const c = PCX.decodeQRZConfirmed(st.qrz);
    $('qrzConfirmed').innerHTML = c ? '<tr><th>Byte</th><th>Op</th><th>Value</th><th>Meaning</th></tr>' + c.map(r => `<tr><td>${r.byte}</td><td><code>${esc(r.op)}</code></td><td>${r.value} (${hx(r.value)})</td><td>${esc(r.meaning)}</td></tr>`).join('') : '<tr><td>Block shorter than 5 bytes</td></tr>';
  }

  function renderSettings() {
    const tb = $('setTable').tBodies[0];
    if (!st.map) { tb.innerHTML = ''; return; }
    const f = $('setFilter').value.trim().toLowerCase();
    const mappedOnly = $('chkMappedOnly').checked;
    tb.innerHTML = PCX.SETTINGS.filter(s => (!f || s.key.toLowerCase().includes(f) || s.desc.toLowerCase().includes(f)) && (!mappedOnly || fieldsFor(s.key).length)).map(s => {
      const fl = fieldsFor(s.key);
      const rv = st.readerVals[s.key];
      const tv = st.targets[s.key];
      const changed = tv !== undefined && rv !== undefined && Number(tv) !== Number(rv);
      const pendingUnmapped = tv !== undefined && !fl.length;
      const input = s.type === 'bool'
        ? `<select data-k="${s.key}"><option value=""></option><option value="0" ${tv === 0 ? 'selected' : ''}>0</option><option value="1" ${tv === 1 ? 'selected' : ''}>1</option></select>`
        : `<input type="number" min="0" data-k="${s.key}" value="${tv ?? ''}">`;
      const tag = fl.length ? `<span class="tag ok" title="${esc(fl.map(x => `byte ${x.byte} mask ${hx(x.mask)} >>${x.shift}`).join('; '))}">byte ${fl.map(x => x.byte).join('+')}</span>`
        : `<span class="tag ${pendingUnmapped ? 'warn' : ''}">unmapped</span>`;
      return `<tr class="${changed ? 'chg' : ''}"><td><strong>${s.key}</strong><div class="muted small">${esc(s.desc)}</div></td><td class="mono">${rv ?? '—'}</td><td>${input}</td><td>${tag}</td></tr>`;
    }).join('');
    tb.querySelectorAll('[data-k]').forEach(el => el.onchange = () => {
      const k = el.dataset.k;
      if (el.value === '') delete st.targets[k]; else st.targets[k] = Number(el.value);
      renderSettings(); $('planBox').hidden = true;
    });
  }
  $('setFilter').oninput = renderSettings;
  $('chkMappedOnly').onchange = renderSettings;
  $('btnResetTargets').onclick = () => { st.targets = { ...st.readerVals }; renderSettings(); $('planBox').hidden = true; log('Targets reset to reader values'); };

  $('btnPlan').onclick = guard(() => {
    if (!st.qrz) throw new Error('Read the configuration (QRZ) first');
    const changed = {};
    for (const [k, v] of Object.entries(st.targets)) if (fieldsFor(k).length && st.readerVals[k] !== undefined && Number(v) !== Number(st.readerVals[k])) changed[k] = v;
    const unwritable = Object.keys(st.targets).filter(k => !fieldsFor(k).length);
    const lines = [];
    let plan = null;
    if (!Object.keys(changed).length) lines.push('No mapped setting differs from the reader.');
    else {
      plan = PCX.planWrite(st.map, st.qrz, changed);
      lines.push(`Settings: ${plan.applied.map(k => `${k} ${st.readerVals[k]} → ${changed[k]}`).join(', ')}`);
      lines.push('', 'Byte changes:');
      plan.diffs.forEach(d => lines.push(`  byte ${String(d.byte).padStart(2)}: ${PCX.hex2(d.a)} → ${PCX.hex2(d.b)}`));
      lines.push('', 'Commands:');
      if (!st.map.writeTemplate) lines.push('  (none — set a write template in the Mapping workbench)');
      plan.commands.forEach(c => lines.push(`  ${c}<CR>`));
    }
    if (unwritable.length) lines.push('', `Not writable (no confirmed byte): ${unwritable.length} setting(s) — ${unwritable.slice(0, 12).join(', ')}${unwritable.length > 12 ? '…' : ''}`);
    st.plan = plan;
    $('planOut').textContent = lines.join('\n');
    const ok = !!(plan && plan.commands.length && st.map.writeValidated);
    $('btnExecWrite').disabled = !ok;
    $('planNote').textContent = !plan ? '' : !st.map.writeTemplate ? 'Writing disabled: no write template.' : !st.map.writeValidated ? 'Writing disabled: template not marked as validated.' : 'The reader is re-read and every byte verified after writing.';
    $('planBox').hidden = false;
  });

  $('btnExecWrite').onclick = guard(async () => {
    const plan = st.plan; const r = need();
    if (!plan || !plan.commands.length) return;
    if (!confirm(`Send ${plan.commands.length} write command(s) to ${r.name}?\n\n${plan.commands.join('\n')}\n\nThese readers control physical access. Continue?`)) return;
    $('btnExecWrite').disabled = true;
    for (const c of plan.commands) {
      const res = await r.command(c, { pollReads: 3 });
      log(`WRITE ${c} → ${res.text || '(no reply)'}`);
    }
    const before = plan.next;
    await readConfig();
    const bad = plan.diffs.filter(d => st.qrz[d.byte] !== before[d.byte]);
    if (bad.length) log(`Verify FAILED on byte(s) ${bad.map(d => `${d.byte} (want ${PCX.hex2(before[d.byte])}, got ${PCX.hex2(st.qrz[d.byte] ?? 0)})`).join(', ')}`, 'err');
    else { log(`Verified: all ${plan.diffs.length} changed byte(s) read back correctly`); r.command(PCX.beepCommand(1, false), { pollReads: 1 }).catch(() => {}); }
  });

  // ---------- presets ----------
  const bundle = window.PCX_PRESETS || { manifest: [], files: {} };
  async function loadManifest() {
    let m = null;
    try { const r = await fetch('presets/manifest.json', { cache: 'no-cache' }); if (r.ok) m = await r.json(); } catch (_) {}
    m = m || bundle.manifest;
    $('presetSel').innerHTML = m.map(p => `<option value="${esc(p.file)}">${esc(p.label)} · ${p.file.endsWith('+') ? '.hwg+' : '.hwg'}</option>`).join('');
  }
  async function fetchPreset(file) {
    try { const r = await fetch('presets/' + encodeURIComponent(file), { cache: 'no-cache' }); if (r.ok) return await r.text(); } catch (_) {}
    if (bundle.files[file] != null) return bundle.files[file];
    throw new Error(`Could not load preset ${file}`);
  }
  function openPreset(name, text) {
    const parsed = PCX.parseHwg(text);
    if (!parsed.configs.length) throw new Error(`${name}: no configuration found`);
    st.preset = { name, parsed, idx: 0 };
    $('presetCfgSel').innerHTML = parsed.configs.map((c, i) => `<option value="${i}">#${i + 1}${c.cardType != null ? ` · card type ${c.cardType}${c.cardPriority ? ' (high priority)' : ''}` : ''}</option>`).join('');
    renderPreset();
    log(`Loaded ${name}: ${parsed.format}, ${parsed.configs.length} configuration(s)`);
  }
  function renderPreset() {
    const p = st.preset;
    $('presetView').hidden = !p;
    if (!p) return;
    const cfg = p.parsed.configs[p.idx];
    $('presetName').textContent = p.name;
    $('presetMeta').textContent = [p.parsed.format, p.parsed.header.libVersion && `library ${p.parsed.header.libVersion}`, p.parsed.header.fwVersion && `firmware ${p.parsed.header.fwVersion}`].filter(Boolean).join(' · ');
    $('presetCfgRow').hidden = p.parsed.configs.length < 2;
    const warn = [];
    if (cfg.legacy) warn.push('Legacy positional .hwg: the position→setting mapping is a best guess (first 19 positions). Remaining positions are kept raw and not applied.');
    if (cfg.fldSepData) warn.push('Contains field-separator data (sFldSepData). No confirmed command writes it, so it is not applied.');
    if (p.parsed.configs.length > 1) warn.push(`Multi-configuration file (${p.parsed.configs.length} card types). Only the selected configuration is applied to the QRZ block.`);
    $('presetWarn').innerHTML = warn.map(esc).join('<br>'); $('presetWarn').hidden = !warn.length;
    const rows = Object.entries(cfg.settings).map(([k, v]) => {
      const w = fieldsFor(k).length > 0, rv = st.readerVals[k];
      return `<tr class="${rv !== undefined && Number(rv) !== Number(v) ? 'chg' : ''}"><td>${esc(k)}</td><td class="mono">${esc(v)}</td><td class="mono">${rv ?? '—'}</td><td>${w ? '<span class="tag ok">yes</span>' : '<span class="tag">no map</span>'}</td></tr>`;
    });
    const unk = Object.entries(cfg.unknown).map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="mono muted">${esc(JSON.stringify(v))}</td><td>—</td><td><span class="tag">raw</span></td></tr>`);
    $('presetTable').tBodies[0].innerHTML = rows.concat(unk).join('');
  }
  $('presetCfgSel').onchange = () => { st.preset.idx = Number($('presetCfgSel').value); renderPreset(); };
  $('btnLoadPreset').onclick = guard(async () => { const f = $('presetSel').value; if (f) openPreset(f, await fetchPreset(f)); });
  $('fileIn').onchange = guard(async () => { const f = $('fileIn').files[0]; if (f) openPreset(f.name, await f.text()); $('fileIn').value = ''; });
  $('btnApplyPreset').onclick = guard(() => {
    const cfg = st.preset.parsed.configs[st.preset.idx];
    let n = 0, w = 0;
    for (const [k, v] of Object.entries(cfg.settings)) if (typeof v === 'number') { st.targets[k] = v; n++; if (fieldsFor(k).length) w++; }
    renderSettings(); $('planBox').hidden = true;
    log(`Applied ${n} setting(s) from ${st.preset.name} to targets (${w} writable with the current map)`);
    document.querySelector('.tabs button[data-t="settings"]').click();
  });

  const download = (name, text, type = 'text/plain') => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('btnExportHwg').onclick = guard(() => {
    const settings = {}, fromTargets = [];
    for (const s of PCX.SETTINGS) {
      if (st.readerVals[s.key] !== undefined) settings[s.key] = st.readerVals[s.key];
      else if (st.targets[s.key] !== undefined) { settings[s.key] = st.targets[s.key]; fromTargets.push(s.key); }
    }
    if (!Object.keys(settings).length) throw new Error('Nothing to export — read the reader (with a field map) or load a preset first');
    let text = PCX.serializeHwgPlus([{ settings }], { libVersion: 'pcProx WebHID Portal', fwVersion: st.qsvText || 'unknown' });
    if (fromTargets.length) text = text.replace(/\r\n\r\n/, `\r\n/ NOTE: not read from the reader (unmapped): ${fromTargets.join(', ')}\r\n\r\n`);
    download('reader-config.hwg+', text);
    log(`Exported ${Object.keys(settings).length} setting(s) (${fromTargets.length} from targets)`);
  });
  $('btnExportCapture').onclick = guard(() => {
    const r = need();
    download(`capture-${r.vidpid.replace(':', '-')}-${Date.now()}.json`, JSON.stringify({
      tool: 'pcProx WebHID Portal', time: new Date().toISOString(), device: { name: r.name, vidpid: r.vidpid, kind: r.kind, reportId: r.reportId, reportLen: r.reportLen, collections: r.describe() },
      version: st.qsvText, qrz: st.qrz ? PCX.toHex(st.qrz, '') : null,
      snapshots: st.snapshots.map(s => ({ label: s.label, cmd: s.cmd, time: s.time, reply: s.text, hex: PCX.toHex(s.bytes, '') })), map: st.map,
    }, null, 2), 'application/json');
  });

  // ---------- workbench ----------
  $('fmKey').innerHTML = PCX.SETTINGS.map(s => `<option>${s.key}</option>`).join('');
  $('btnSnap').onclick = guard(async () => {
    const cmd = $('snapCmd').value;
    const p = await query(cmd);
    const snap = { id: ++st.snapSeq, cmd, label: $('snapLabel').value.trim() || `${cmd} #${st.snapSeq}`, bytes: p.bytes || new Uint8Array(0), text: p.text, time: new Date().toISOString() };
    st.snapshots.push(snap);
    if (cmd === 'QRZ') { st.qrz = snap.bytes; recomputeReaderVals(); renderQrz(); renderSettings(); }
    if (st.selA == null) st.selA = snap.id; else if (st.selB == null || st.selB !== snap.id) { st.selB = snap.id; }
    $('snapLabel').value = '';
    renderSnaps(); renderDiff();
  });
  function renderSnaps() {
    $('snapTable').tBodies[0].innerHTML = st.snapshots.map(s => `<tr>
      <td><input type="radio" name="snapA" value="${s.id}" ${st.selA === s.id ? 'checked' : ''}></td>
      <td><input type="radio" name="snapB" value="${s.id}" ${st.selB === s.id ? 'checked' : ''}></td>
      <td>${esc(s.label)}</td><td>${s.cmd}</td><td class="mono small">${PCX.toHex(s.bytes)}</td>
      <td><button class="ghost" data-del="${s.id}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No snapshots yet.</td></tr>';
    document.querySelectorAll('[name=snapA]').forEach(r => r.onchange = () => { st.selA = Number(r.value); renderDiff(); });
    document.querySelectorAll('[name=snapB]').forEach(r => r.onchange = () => { st.selB = Number(r.value); renderDiff(); });
    document.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
      const id = Number(b.dataset.del); st.snapshots = st.snapshots.filter(s => s.id !== id);
      if (st.selA === id) st.selA = null; if (st.selB === id) st.selB = null; renderSnaps(); renderDiff();
    });
  }
  const tz = m => { let s = 0; while (m && !(m & 1)) { m >>= 1; s++; } return s; };
  function renderDiff() {
    const A = st.snapshots.find(s => s.id === st.selA), B = st.snapshots.find(s => s.id === st.selB);
    const out = $('diffOut');
    if (!A || !B || A === B) { out.className = 'muted'; out.textContent = 'Select two different snapshots as A and B.'; return; }
    if (A.cmd !== B.cmd) { out.className = 'muted'; out.textContent = `A is ${A.cmd} and B is ${B.cmd} — compare captures of the same command.`; return; }
    const d = PCX.diffBlocks(A.bytes, B.bytes);
    out.className = '';
    if (!d.length) { out.innerHTML = '<p class="muted">No byte differs between A and B.</p>'; return; }
    out.innerHTML = `<table class="data"><tr><th>Byte</th><th>A</th><th>B</th><th>Changed bits</th><th>Values (masked)</th><th></th></tr>${d.map(x => {
      const sh = tz(x.bits);
      return `<tr><td>${x.byte}</td><td class="mono">${x.a == null ? '—' : PCX.hex2(x.a)}</td><td class="mono">${x.b == null ? '—' : PCX.hex2(x.b)}</td>
      <td class="mono">${x.bits.toString(2).padStart(8, '0')}</td><td class="mono">${((x.a ?? 0) & x.bits) >> sh} → ${((x.b ?? 0) & x.bits) >> sh}</td>
      <td><button class="secondary" data-use="${x.byte}" data-mask="${x.bits}">Use</button></td></tr>`;
    }).join('')}</table>${d.length === 2 && d[1].byte === d[0].byte + 1 ? '<p class="muted small">Two adjacent bytes changed — this may be one 16-bit field (width 2, mask FFFF).</p>' : ''}`;
    out.querySelectorAll('[data-use]').forEach(b => b.onclick = () => {
      const mask = Number(b.dataset.mask);
      $('fmCmd').value = A.cmd; $('fmByte').value = b.dataset.use; $('fmWidth').value = '1';
      // widen a single changed bit to the bit itself; a multi-bit change to the span of changed bits
      const sh = tz(mask), hi = 31 - Math.clz32(mask), span = ((1 << (hi - sh + 1)) - 1) << sh;
      $('fmMask').value = span.toString(16).toUpperCase(); $('fmShift').value = sh;
      $('fmNote').value = `${A.label} → ${B.label}`;
      $('fmKey').focus();
    });
  }
  // command selector for the field (snapshots of any command can be mapped; only QRZ is written)
  $('fmByte').closest('.formgrid').insertAdjacentHTML('afterbegin', '<label>Block <select id="fmCmd"><option>QRZ</option><option>QSV</option><option>QDD</option><option>QS0</option><option>QUP</option><option>GS0</option><option>GL0</option></select></label>');
  $('fmWidth').onchange = () => { $('fmMask').value = $('fmWidth').value === '2' ? 'FFFF' : 'FF'; $('fmShift').value = 0; };

  $('btnAddField').onclick = guard(() => {
    const f = { key: $('fmKey').value, cmd: $('fmCmd').value, byte: Number($('fmByte').value), width: Number($('fmWidth').value), mask: parseInt($('fmMask').value, 16), shift: Number($('fmShift').value), note: $('fmNote').value.trim() };
    PCX.validateField(f);
    const clash = st.map.fields.find(x => x.cmd === f.cmd && x.key !== f.key && rangesOverlap(x, f));
    if (clash && !confirm(`${clash.key} already uses overlapping bits of byte ${clash.byte}. Add anyway?`)) return;
    st.map.fields = st.map.fields.filter(x => !(x.key === f.key && x.cmd === f.cmd && x.byte === f.byte));
    st.map.fields.push(f);
    persistMap(); recomputeReaderVals();
    for (const [k, v] of Object.entries(st.readerVals)) if (!(k in st.targets)) st.targets[k] = v;
    renderMapUi(); renderQrz(); renderSettings(); renderPreset();
    log(`Mapped ${f.key} → ${f.cmd} byte ${f.byte}${f.width === 2 ? '-' + (f.byte + 1) : ''} mask ${hx(f.mask)} >>${f.shift}`);
    $('fmNote').value = '';
  });
  function rangesOverlap(a, b) {
    const bitsOf = f => { const s = new Set(); for (let i = 0; i < f.width * 8; i++) if (f.mask & (1 << i)) s.add((f.byte + f.width - 1 - Math.floor(i / 8)) * 8 + (i % 8)); return s; };
    const A = bitsOf(a); for (const x of bitsOf(b)) if (A.has(x)) return true; return false;
  }
  function renderMapUi() {
    const m = st.map; if (!m) return;
    $('fieldTable').tBodies[0].innerHTML = m.fields.slice().sort((a, b) => a.byte - b.byte).map(f => `<tr><td>${esc(f.key)}</td><td>${f.cmd}</td><td>${f.byte}</td><td>${f.width}</td><td class="mono">${hx(f.mask)}</td><td>${f.shift}</td><td class="muted small">${esc(f.note)}</td>
      <td><button class="ghost" data-rm="${esc(f.key)}|${f.cmd}|${f.byte}">✕</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No fields mapped yet.</td></tr>';
    $('fieldTable').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const [k, c, by] = b.dataset.rm.split('|');
      m.fields = m.fields.filter(f => !(f.key === k && f.cmd === c && f.byte === Number(by)));
      persistMap(); recomputeReaderVals(); renderMapUi(); renderQrz(); renderSettings(); renderPreset();
    });
    $('fmTemplate').value = m.writeTemplate; $('fmValidated').checked = !!m.writeValidated;
    $('lyBits').value = m.layout.bitCountByte; $('lyStart').value = m.layout.idStart; $('lyLen').value = m.layout.idLen; $('lyRev').value = m.layout.reverse ? '1' : '0';
    $('lyPoll').value = m.pollCommand || '';
  }
  function persistMap() { $('mapStatus').textContent = PCX.saveMap(st.map) ? `Saved for ${st.map.vidpid} in this browser` : 'Browser storage unavailable — export the map to keep it'; }
  $('fmTemplate').onchange = guard(() => {
    const t = $('fmTemplate').value.trim();
    if (t) PCX.renderWrite(t, new Uint8Array(4), [{ byte: 0, a: 0, b: 1 }]); // syntax check
    st.map.writeTemplate = t; st.map.writeValidated = false; $('fmValidated').checked = false;
    persistMap(); $('planBox').hidden = true; log(`Write template set to "${t || '(none)'}" — not validated`);
  });
  $('fmValidated').onchange = () => {
    if ($('fmValidated').checked && !st.map.writeTemplate) { $('fmValidated').checked = false; return log('Set a write template first', 'warn'); }
    if ($('fmValidated').checked && !confirm('Confirm you have validated this write template (write, re-read, diff) on a reader you can safely re-flash.')) { $('fmValidated').checked = false; return; }
    st.map.writeValidated = $('fmValidated').checked; persistMap(); $('planBox').hidden = true;
  };
  ['lyBits', 'lyStart', 'lyLen', 'lyRev', 'lyPoll'].forEach(id => $(id).onchange = () => {
    st.map.layout = { bitCountByte: Number($('lyBits').value), idStart: Number($('lyStart').value), idLen: Number($('lyLen').value), reverse: $('lyRev').value === '1' };
    st.map.pollCommand = $('lyPoll').value.trim();
    persistMap();
    if (st.listening) { stopListening(); startListening(); }
  });
  $('btnSaveMap').onclick = persistMap;
  $('btnExportMap').onclick = () => download(`fieldmap-${st.map.vidpid.replace(':', '-')}.json`, JSON.stringify(st.map, null, 2), 'application/json');
  $('mapFile').onchange = guard(async () => {
    const f = $('mapFile').files[0]; if (!f) return;
    const j = JSON.parse(await f.text()); $('mapFile').value = '';
    if (j.version !== 1 || !Array.isArray(j.fields)) throw new Error('Not a field map file');
    j.fields.forEach(PCX.validateField);
    if (j.vidpid && j.vidpid !== st.map.vidpid && !confirm(`This map was made for ${j.vidpid}, the reader is ${st.map.vidpid}. Import anyway?`)) return;
    st.map = Object.assign(PCX.defaultMap(st.map.vidpid), j, { vidpid: st.map.vidpid, writeValidated: false });
    persistMap(); recomputeReaderVals(); renderMapUi(); renderQrz(); renderSettings(); renderPreset();
    log(`Imported field map: ${st.map.fields.length} field(s). Re-confirm the write template before writing.`);
  });
  $('btnClearMap').onclick = () => {
    if (!confirm('Clear the field map for this reader model?')) return;
    st.map = PCX.defaultMap(st.map.vidpid); persistMap(); recomputeReaderVals(); renderMapUi(); renderQrz(); renderSettings(); renderPreset();
  };

  // ---------- console ----------
  $('conQuick').innerHTML = PCX.COMMANDS.filter(c => c.dir === 'read').map(c => `<button class="ghost" data-q="${c.cmd}" title="${esc(c.desc)}">${c.cmd}</button>`).join('');
  $('conQuick').querySelectorAll('[data-q]').forEach(b => b.onclick = () => { $('conCmd').value = b.dataset.q; $('btnConSend').click(); });
  const conOut = s => { $('conOut').textContent = s + '\n' + $('conOut').textContent.slice(0, 30000); };
  $('btnConSend').onclick = guard(async () => {
    const cmd = $('conCmd').value.trim(); if (!cmd) return;
    if (PCX.isWriteCommand(cmd) && !confirm(`"${cmd}" is a write/command. Send it to the reader?`)) return;
    const res = await need().command(cmd);
    const p = PCX.parseQueryReply(res.text, cmd);
    conOut(`> ${cmd}\n< ${res.text || '(empty)'}${p.bytes && p.bytes.length ? `\n  payload ${p.bytes.length} B: ${PCX.toHex(p.bytes)}\n  ascii: ${asciiOf(p.bytes)}` : ''}\n`);
  });
  $('conCmd').onkeydown = e => { if (e.key === 'Enter') $('btnConSend').click(); };
  $('btnRawSend').onclick = guard(async () => {
    const b = PCX.hexToBytes($('conRaw').value);
    if (!confirm(`Send raw feature report (${b.length} bytes)?\n${PCX.toHex(b)}`)) return;
    const r = await need().rawExchange(b);
    conOut(`> RAW ${PCX.toHex(b)}\n< ${PCX.toHex(r)}\n  |${asciiOf(r)}|\n`);
  });
  $('btnRawGet').onclick = guard(async () => { const r = await need().rawRead(); conOut(`< GET ${PCX.toHex(r)}\n  |${asciiOf(r)}|\n`); });
  function applyTiming() {
    if (!st.reader) return;
    st.reader.pollReads = Math.max(1, Number($('tmPolls').value) || 10);
    st.reader.pollDelay = Math.max(0, Number($('tmDelay').value) || 0);
    st.reader.continuationReads = Math.max(0, Number($('tmCont').value) || 0);
  }
  ['tmPolls', 'tmDelay', 'tmCont'].forEach(id => $(id).onchange = applyTiming);

  // ---------- secure ----------
  $('btnSecure').onclick = guard(async () => {
    const r = need();
    const frame = PCX.secureReadFrame($('secParams').value, r.reportLen);
    const resp = await r.rawExchange(frame);
    $('secOut').textContent = `TX ${PCX.toHex(frame)}\nRX ${PCX.toHex(resp)}\n   |${asciiOf(resp)}|`;
  });

  $('btnLogClear').onclick = () => { $('log').textContent = ''; };
  loadManifest();
  log('Portal ready. Connect a reader, or try the simulated reader.');
})();
