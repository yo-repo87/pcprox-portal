/* pcProx Portal — UI wiring (utility-style layout). Device I/O goes through PCX.HidReader / PCX.SimReader. */
(function () {
  'use strict';
  const PCX = window.PCX;
  const $ = id => document.getElementById(id);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hx = n => '0x' + Number(n).toString(16).toUpperCase().padStart(2, '0');
  const asciiOf = bytes => Array.from(bytes, b => (b >= 0x20 && b < 0x7F ? String.fromCharCode(b) : '.')).join('');
  const STEP = { iBitStrmTO: 4, iIDHoldTO: 50, iIDLockOutTm: 50, iUSBKeyPrsTm: 4, iUSBKeyRlsTm: 4 };
  const UNIT = { iBitStrmTO: 'ms', iIDHoldTO: 'ms', iIDLockOutTm: 'ms', iUSBKeyPrsTm: 'ms', iUSBKeyRlsTm: 'ms' };

  const newSlot = () => ({ src: '', label: '', targets: {}, cardType: null, cardPriority: null });
  const st = {
    reader: null, map: PCX.defaultMap('none'), protocol: 'bin',
    qrz: null, fw: '', readerVals: {},
    slots: [newSlot(), newSlot(), newSlot(), newSlot()], active: 0,
    lib: [], lastFile: null,
    snapshots: [], snapSeq: 0, selA: null, selB: null,
    plan: null, listening: false, pollTimer: null, lastPoll: 0, card: null,
  };
  const slot = () => st.slots[st.active];
  // Reader configurations: rc[i] = { block, vals, cardType, prio }. pcProx Plus readers have several.
  st.rc = []; st.plus = null;
  const viewIdx = () => (st.active < st.rc.length ? st.active : 0);
  Object.defineProperty(st, 'qrz', {
    get: () => (st.rc[viewIdx()] || {}).block || null,
    set: v => { const i = viewIdx(); st.rc[i] = Object.assign(st.rc[i] || {}, { block: v }); },
  });
  Object.defineProperty(st, 'readerVals', {
    get: () => (st.rc[viewIdx()] || {}).vals || {},
    set: v => { const i = viewIdx(); if (st.rc[i]) st.rc[i].vals = v; },
  });
  st.priority = 1;
  const blockCmd = () => (st.protocol === 'bin' ? 'CFG' : 'QRZ');
  const isBin = () => st.protocol === 'bin';

  // ---------- log / status ----------
  function log(msg, kind) {
    const l = $('log');
    l.textContent = `[${new Date().toLocaleTimeString()}] ${kind === 'err' ? 'ERROR ' : kind === 'warn' ? 'WARN  ' : ''}${msg}\n` + l.textContent.slice(0, 60000);
    if (kind === 'err') status(msg, true);
  }
  function status(msg, bad) { $('stLeft').textContent = msg; $('stLeft').style.color = bad ? 'var(--bad)' : ''; }
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

  // ---------- navigation ----------
  function showPage(p) {
    $$('.nav a[data-p]').forEach(a => a.classList.toggle('on', a.dataset.p === p));
    $$('.page').forEach(el => el.hidden = el.id !== 'p-' + p);
    if (p === 'timing' || p === 'format') renderSettings();
  }
  $$('.nav a[data-p]').forEach(a => a.onclick = e => { e.preventDefault(); showPage(a.dataset.p); });
  const openTest = open => { $('testArea').hidden = !open; $('navTest').classList.toggle('on', open); };
  $('navTest').onclick = e => { e.preventDefault(); openTest($('testArea').hidden); };
  $('btnTestClose').onclick = () => openTest(false);
  $('trayLog').onclick = () => { openTest(true); $('log').scrollIntoView({ behavior: 'smooth' }); };
  $$('.subtabs button').forEach(b => b.onclick = () => {
    $$('.subtabs button').forEach(x => x.classList.toggle('on', x === b));
    $$('.sub').forEach(s => s.hidden = s.id !== 's-' + b.dataset.s);
  });

  // menus
  const closeMenus = () => { $('kebabMenu').hidden = true; $('hambMenu').hidden = true; };
  $('btnKebab').onclick = e => { e.stopPropagation(); const h = $('kebabMenu').hidden; closeMenus(); $('kebabMenu').hidden = !h; };
  $('btnHamb').onclick = e => { e.stopPropagation(); const h = $('hambMenu').hidden; closeMenus(); $('hambMenu').hidden = !h; };
  document.addEventListener('click', closeMenus);
  const menuActions = {
    readcfg: () => readConfig(), version: () => readVersion(), forget: () => forget(), disconnect: () => detach(),
    sim: () => attach(new PCX.SimReader()), exportHwg: () => exportHwg(false), exportCap: () => exportCapture(), exportMap: () => exportMap(),
    about: () => alert('pcProx Portal — browser-only reader programming over WebHID.\nBuilt from the pcProx USB HID & Configuration Protocol Reference. Not affiliated with rf IDeas.'),
  };
  $$('.menu [data-m]').forEach(b => b.onclick = guard(() => { closeMenus(); return menuActions[b.dataset.m](); }));

  // quick-action (+) menu
  const fab = open => { $('fabVeil').style.top = document.querySelector('.top').offsetHeight + 'px'; $('fabMenu').hidden = !open; $('fabVeil').hidden = !open; $('btnFab').classList.toggle('open', open); };
  $('btnFab').onclick = () => fab($('fabMenu').hidden);
  $('fabVeil').onclick = () => fab(false);
  const fabActions = {
    open: () => { $('presetSlot').value = String(st.active); $('fileIn').click(); },
    save: () => exportHwg(true),
    raw: () => exportCapture(),
  };
  $$('#fabMenu [data-f]').forEach(b => b.onclick = guard(() => { fab(false); return fabActions[b.dataset.f] && fabActions[b.dataset.f](); }));

  // ---------- connect ----------
  async function attach(reader) {
    if (st.reader) await detach(true);
    const info = await reader.open();
    st.reader = reader;
    reader.on('tx', (b, id) => wire('TX', b, id));
    reader.on('rx', (b, id) => wire('RX', b, id));
    reader.on('input', b => { if (st.listening) handleCard(b, 'input'); });
    // Protocol: 8-byte feature reports => pcProx binary; 24-byte => reference-doc ASCII.
    const feats = reader.describe().flatMap(c => c.feature).map(f => f.bytes).filter(Boolean);
    st.protocol = feats.length && feats.every(n => n > 8) ? 'ascii' : 'bin';
    applyProtocol(false);
    st.rc = []; st.plus = null; st.fw = ''; st.plan = null; st.snapshots = []; st.selA = st.selB = null;
    if (st.slots[0].src === 'reader') st.slots[0] = newSlot();

    $('devEmpty').hidden = true; $('devBody').hidden = false; $('btnKebab').disabled = false;
    $('dvName').textContent = `#01 ${reader.name}`;
    $('dvFw').textContent = '—';
    $('dvVid').textContent = `${reader.vidpid} ${reader.kind === 'sim' ? 'Simulator' : 'RF IDeas'}`;
    $('hiModel').textContent = reader.kind === 'sim' ? 'Simulator (illustrative data only)' : PCX.modelName(reader.vid, reader.pid);
    $('hiCols').innerHTML = reader.describe().map(c =>
      `<div><code>page ${hx(c.usagePage)} usage ${hx(c.usage)}</code> ${c.usagePage >= 0xFF00 ? '<span class="tag ok">vendor</span>' : ''} ` +
      `<span class="muted small">feature ${c.feature.map(f => `#${f.id}:${f.bytes}B`).join(', ') || '—'} · input ${c.input.map(f => `#${f.id}:${f.bytes}B`).join(', ') || '—'}</span></div>`).join('') || '<span class="muted">none reported</span>';
    if (![...$('selReportId').options].some(o => o.value === String(info.reportId))) $('selReportId').insertAdjacentHTML('beforeend', `<option>${info.reportId}</option>`);
    $('selReportId').value = String(info.reportId);
    if (isBin()) reader.reportLen = 8;
    $('inReportLen').value = reader.reportLen;
    $('hiRepNote').textContent = info.found ? 'from the HID descriptor' : 'no feature report in descriptor — defaults';
    updateRep();
    $('btnDisconnect').disabled = false;
    $('btnSimTap').hidden = reader.kind !== 'sim';
    $('stRight').textContent = `#1 USB ${reader.vidpid}${reader.kind === 'sim' ? ' (simulated)' : ''}`;
    applyTiming(); renderMapUi(); renderSnaps(); renderDiff(); renderQrz(); renderSlots(); renderSettings();
    log(`Connected: ${reader.name} ${reader.vidpid} · ${isBin() ? 'binary 8-byte' : 'ASCII 24-byte'} protocol · report id ${reader.reportId}, ${reader.reportLen}-byte data`);
    if (!reader.hasVendorCollection()) log('No vendor-defined collection reported. If commands fail, switch the reader out of keyboard-wedge mode.', 'warn');
    status('Connected');
    // Read version + configuration on connect, as the vendor utility does (reads only).
    try { await readVersion(); } catch (e) { log(`Version: ${e.message}`, 'warn'); }
    try { await readConfig(); } catch (e) { log(`Configuration: ${e.message}`, 'warn'); }
    await readVolume();
  }
  // Switch protocol: reload the per-protocol field map and refresh the UI.
  function applyProtocol(reread) {
    const r = st.reader, bin = isBin();
    $('selProto').value = st.protocol;
    $('protoNote').textContent = bin
      ? 'Built-in settings map (pages 0–2) from open-source notes tested on RDR-6081AKU; confirm values match the vendor utility.'
      : 'Configuration layout must be mapped by diffing captures (Tools → Mapping workbench).';
    if (r) {
      r.reportLen = bin ? 8 : 24; $('inReportLen').value = r.reportLen; updateRep();
      st.map = PCX.loadMap(r.vidpid, st.protocol);
    }
    $('beepNote').textContent = '';
    ['selVol', 'btnDefSave', 'btnDefRestore', 'btnDefFactory'].forEach(id => $(id).disabled = !bin);
    $('snapCmd').innerHTML = (bin ? ['CFG', 'DEV', 'P3', 'P5', 'C8C0', 'C8C1', 'C8C2'] : ['QRZ', 'QSV', 'QDD', 'QS0', 'QUP', 'GS0', 'GL0'])
      .map(c => `<option value="${c}">${SNAP_LABEL[c] || c}</option>`).join('');
    $('fmCmd').value = blockCmd();
    $('blkName').textContent = bin ? 'Configuration pages 0–2 (byte = page × 8 + position)' : 'QRZ block';
    $('valLabel').textContent = bin ? 'Values read from this reader match the vendor utility (map verified)' : 'Validated on a re-flashable reader';
    $('fmTemplate').disabled = bin; $('fmTemplate').placeholder = bin ? 'not used — the 8-byte protocol writes whole pages' : '(none — writing disabled)';
    $('eeRow').hidden = !bin;
    st.rc = []; st.plus = null; st.snapshots = []; st.selA = st.selB = null;
    if (st.slots[0].src === 'reader') st.slots[0] = newSlot();
    renderMapUi(); renderSnaps(); renderDiff(); renderQrz(); renderSlots(); renderSettings();
    if (reread && r) { readVersion().catch(e => log(`Version: ${e.message}`, 'warn')).then(() => readConfig()).catch(e => log(`Configuration: ${e.message}`, 'warn')); }
  }
  const SNAP_LABEL = { CFG: 'Config pages 0–2', DEV: 'Device info (0x8A)', P3: 'Page 3 (0x83)', P5: 'Page 5 (0x85)', C8C0: '0x8C 01 00', C8C1: '0x8C 01 01', C8C2: '0x8C 01 02' };
  $('selProto').onchange = () => { stopListening(); st.protocol = $('selProto').value; log(`Protocol set to ${st.protocol === 'bin' ? 'binary 8-byte' : 'ASCII 24-byte'}`); applyProtocol(true); };
  async function detach(silent) {
    stopListening();
    const r = st.reader; st.reader = null;
    if (r) { try { await r.close(); } catch (_) {} }
    $('devEmpty').hidden = false; $('devBody').hidden = true; $('btnKebab').disabled = true;
    $('btnDisconnect').disabled = true; $('btnSimTap').hidden = true;
    $('hiModel').textContent = '—'; $('hiCols').textContent = '—';
    $('stRight').textContent = 'No reader';
    if (!silent) { log('Disconnected'); status('Disconnected'); }
  }
  async function forget() {
    const r = st.reader; if (!r || r.kind === 'sim') return;
    if (!confirm('Revoke this site\'s permission for the reader?')) return;
    await detach(true); await r.forget(); log('Device permission revoked');
  }
  const connect = guard(async () => {
    const devs = await PCX.HidReader.request();
    if (!devs.length) return status('No device selected');
    await attach(new PCX.HidReader(devs[0]));
  });
  $('btnConnect').onclick = connect;
  $('lnkConnect').onclick = e => { e.preventDefault(); connect(); };
  $('lnkSim').onclick = e => { e.preventDefault(); guard(() => attach(new PCX.SimReader()))(); };
  $('traySim').onclick = guard(() => attach(new PCX.SimReader()));
  $('btnDisconnect').onclick = guard(() => detach());
  if (PCX.HidReader.supported()) {
    navigator.hid.addEventListener('disconnect', e => { if (st.reader && st.reader.device === e.device) { log('Reader unplugged', 'warn'); detach(true); } });
    navigator.hid.addEventListener('connect', guard(async e => { if (!st.reader && PCX.VENDOR_IDS.includes(e.device.vendorId)) await attach(new PCX.HidReader(e.device)); }));
    PCX.HidReader.granted().then(d => d.length && attach(new PCX.HidReader(d[0]))).catch(e => log(e.message, 'err'));
  }
  function updateRep() { if (st.reader) $('dvRep').textContent = `id ${st.reader.reportId} · ${st.reader.reportLen} B`; }
  $('selReportId').onchange = () => { if (st.reader) { st.reader.reportId = Number($('selReportId').value); updateRep(); log(`Report id set to ${st.reader.reportId}`); } };
  $('inReportLen').onchange = () => { if (st.reader) { const n = Math.max(8, Math.min(24, Number($('inReportLen').value) || 24)); st.reader.reportLen = n; $('inReportLen').value = n; updateRep(); } };

  // ---------- queries ----------
  async function query(cmd) {
    const r = need();
    status(`Sending ${cmd}…`);
    const res = await r.command(cmd);
    const p = PCX.parseQueryReply(res.text, cmd);
    if (!p.ok) throw new Error(p.error);
    log(`${cmd} → ${res.text}${p.bytes ? ` (${p.bytes.length} bytes)` : ''}`);
    if (p.oddNibble) log(`${cmd} payload had an odd number of hex digits; last nibble dropped`, 'warn');
    status('Ready');
    return { ...p, text: res.text };
  }
  async function readVersion() {
    if (isBin()) {
      const b = await need().bin([PCX.BIN.DEVINFO]);
      const d = PCX.decodeDevInfo(b);
      log(`Device info (0x8A): ${PCX.toHex(b)}${d ? ` → firmware ${d.firmware}, device type 0x${d.deviceType.toString(16).toUpperCase()}` : ''}`);
      st.fw = d && b.some(x => x) ? d.firmware : '';
      $('dvFw').textContent = st.fw || '—';
      return;
    }
    const p = await query('QSV');
    st.fw = p.bytes && p.bytes.length ? asciiOf(p.bytes) : p.text.slice(3);
    $('dvFw').textContent = st.fw || '—';
  }
  const beep = (level, long) => guard(async () => {
    if (isBin()) {
      const n = Math.min(long ? 2 : 5, Math.max(1, Number(level()) || 1));
      await need().bin(PCX.BIN.beep(n, long));
      return log(`Beep: ${n} ${long ? 'long' : 'short'} (8C 03 ${PCX.hex2(n | (long ? 0x80 : 0))})`);
    }
    const cmd = PCX.beepCommand(level(), long);
    const res = await need().command(cmd, { pollReads: 2 });
    log(`${cmd} sent${res.text ? ` → ${res.text}` : ''}`);
  });
  $('btnBeepS').onclick = beep(() => $('selBeepS').value, false);
  $('btnBeepL').onclick = beep(() => $('selBeepL').value, true);
  $('trayBeep').onclick = beep(() => 1, false);

  // Beeper volume (8C 06 read / 8C 86 set) and memory-bank copies (89 82 src dst) — binary protocol
  async function readVolume() {
    if (!isBin() || !st.reader) return;
    try { const b = await st.reader.bin(PCX.BIN.VOLUME_GET); if (b[2] <= 3) $('selVol').value = String(b[2]); log(`Beeper volume: ${['off', 'low', 'medium', 'high'][b[2]] ?? b[2]}`); }
    catch (e) { log(`Volume: ${e.message}`, 'warn'); }
  }
  $('selVol').onchange = guard(async () => {
    const v = Number($('selVol').value);
    await need().bin(PCX.BIN.volumeSet(v));
    log(`Beeper volume set to ${['off', 'low', 'medium', 'high'][v]}`);
  });
  const bankCopy = (pairs, what, warn) => guard(async () => {
    const r = need();
    if (!isBin()) throw new Error('Memory-bank commands are only known for the 8-byte protocol');
    if (!st.plus && !confirm('This reader did not report multiple configurations. The bank-copy command was found on the pcProx Plus path of the vendor library and may not apply. Send anyway?')) return;
    if (!confirm(`${what}?${warn ? '\n\n' + warn : ''}`)) return;
    for (const [a, b] of pairs) { const rep = await r.bin(PCX.BIN.blockMove(a, b)); log(`Bank copy ${a}→${b}: ${PCX.toHex(rep)}`); await PCX.sleep(100); }
    log(`${what}: done`); status(`${what}: done`);
    st.slots.forEach((sl, i) => { if (sl.src === 'reader') st.slots[i] = newSlot(); });
    await readConfig();
  });
  const B = PCX.BIN.BANK;
  $('btnDefSave').onclick = bankCopy([[B.WORKING, B.STORED]], 'Save the current configuration as the user defaults');
  $('btnDefRestore').onclick = bankCopy([[B.STORED, B.WORKING]], 'Restore the saved user defaults', 'Unsaved changes on the reader are replaced.');
  $('btnDefFactory').onclick = bankCopy([[B.FACTORY, B.STORED], [B.FACTORY, B.WORKING]], 'Reset the reader to FACTORY defaults', 'This replaces the stored user defaults too and cannot be undone. Export a .hwg+ first.');

  // ---------- configuration slots ----------
  const fieldsFor = k => st.map.fields.filter(f => f.key === k && f.cmd === blockCmd());
  function valsOf(block) {
    const v = {};
    if (!block) return v;
    for (const f of st.map.fields) {
      if (f.cmd !== blockCmd()) continue;
      const x = PCX.extractField(block, f);
      if (x !== undefined) v[f.key] = x;
    }
    return v;
  }
  function recomputeReaderVals() { st.rc.forEach(c => { c.vals = valsOf(c.block); }); }
  async function readPages() {
    const r = need(), out = new Uint8Array(24);
    for (const pg of PCX.BIN.PAGES) out.set((await r.bin([PCX.BIN.PAGE(pg)])).slice(0, 8), pg * 8);
    if (out.every(x => x === 0)) throw new Error('Reader returned all-zero configuration pages — it may not speak the 8-byte protocol (try the ASCII protocol on Home)');
    return out;
  }
  async function selectConfig(i) {
    const b = await need().bin(PCX.BIN.selectConfig(i));
    if (!(b[0] === 0x89 && b[1] === 0x81)) log(`Select configuration ${i + 1}: unexpected reply ${PCX.toHex(b)}`, 'warn');
  }
  // Reads the block of one configuration (selecting it first on multi-config readers).
  async function readBlock(cfg = viewIdx()) {
    if (!isBin()) return (await query('QRZ')).bytes;
    if (st.plus) await selectConfig(cfg);
    const out = await readPages();
    if (st.plus) await selectConfig(st.plus.active);
    return out;
  }
  async function readConfig() {
    if (!isBin()) {
      st.rc = [{ block: (await query('QRZ')).bytes }];
    } else {
      const r = need();
      // 89 01 -> [89, ?, activeConfig, configCount]: present only on multi-configuration (pcProx Plus) readers
      const info = await r.bin(PCX.BIN.PLUS_INFO);
      st.plus = info[0] === 0x89 && info[3] >= 1 && info[3] <= 11 ? { count: info[3], active: Math.min(info[2], info[3] - 1) } : null;
      log(st.plus ? `Multi-configuration reader: ${st.plus.count} configurations, active ${st.plus.active + 1}` : 'Single-configuration reader');
      status('Reading configuration…');
      st.rc = [];
      const n = st.plus ? st.plus.count : 1;
      for (let i = 0; i < n; i++) {
        if (st.plus) await selectConfig(i);
        const block = await readPages();
        let cardType = null, prio = 0;
        if (st.plus) {
          const p4 = await r.bin([PCX.BIN.PAGE(4)]);
          cardType = p4[1] | (p4[2] << 8); prio = p4[3] & 1;
        }
        st.rc.push({ block, cardType, prio });
        log(`Config ${i + 1}${cardType != null ? ` (${cardTypeName(cardType)}${prio ? ', high priority' : ''})` : ''}: ${PCX.toHex(block.slice(0, 8))} | ${PCX.toHex(block.slice(8, 16))} | ${PCX.toHex(block.slice(16))}`);
      }
      if (st.plus) await selectConfig(st.plus.active);
    }
    recomputeReaderVals();
    st.rc.forEach((c, i) => {
      if (i >= st.slots.length) return;
      const sl = st.slots[i];
      if (!sl.src || sl.src === 'reader') st.slots[i] = readerSlot(i);
      else for (const [k, v] of Object.entries(c.vals)) if (!(k in sl.targets)) sl.targets[k] = v;
    });
    const hp = st.rc.findIndex(c => c.prio);
    if (hp >= 0) st.priority = hp + 1;
    renderQrz(); renderSlots(); renderSettings(); renderPresetTable();
    log(`Read ${st.rc.length} configuration(s), ${Object.keys(st.rc[0].vals).length} mapped setting(s) each`);
    status(`Read ${st.rc.length} configuration(s)`);
  }
  function readerSlot(i) {
    const c = st.rc[i];
    const label = `Reader${st.rc.length > 1 ? ` #${i + 1}` : ''}${c.cardType != null ? ` · ${(window.PCX_CARD_TYPES || {})[Number(c.cardType).toString(16).toUpperCase().padStart(4, '0')] || 'card type ' + c.cardType}` : ''}`;
    return { ...newSlot(), src: 'reader', label, targets: { ...c.vals }, cardType: c.cardType, cardPriority: c.prio };
  }
  $('trayRead').onclick = guard(readConfig);

  const cardTypeName = code => {
    const h = Number(code).toString(16).toUpperCase().padStart(4, '0');
    const n = (window.PCX_CARD_TYPES || {})[h];
    return n ? `${n} (${h})` : `card type ${h}`;
  };
  function slotOptions(i) {
    const o = ['<option value="">— empty —</option>'];
    if (i < Math.max(1, st.rc.length)) o.push(`<option value="reader">${st.rc[i] ? esc(readerSlot(i).label) : 'Reader configuration (not read yet)'}</option>`);
    const types = Object.entries(window.PCX_CARD_TYPES || {}).sort((a, b) => a[1].localeCompare(b[1]));
    if (types.length) o.push('<optgroup label="Card type (no settings)">' + types.map(([h, n]) => `<option value="t:${h}">${esc(n)}</option>`).join('') + '</optgroup><optgroup label="Presets">');
    st.lib.forEach((p, li) => p.parsed.configs.forEach((c, ci) =>
      o.push(`<option value="p:${li}:${ci}">${esc(p.label)}${p.parsed.configs.length > 1 ? ` · #${ci + 1}` : ''}${c.cardType != null ? ` · ${esc(cardTypeName(c.cardType))}` : ''}</option>`)));
    if (types.length) o.push('</optgroup>');
    return o.join('');
  }
  function renderSlots() {
    $('slots').innerHTML = st.slots.map((s, i) => `<div class="slot ${i === st.active ? 'on' : ''} ${s.src ? 'filled' : ''}">
      <button class="num" data-i="${i}" title="Edit configuration ${i + 1}">${i + 1}</button>
      <select data-i="${i}">${slotOptions(i)}</select><span class="dot" title="${s.src ? 'has settings' : 'empty'}"></span></div>`).join('');
    st.slots.forEach((s, i) => { const sel = $('slots').querySelector(`select[data-i="${i}"]`); sel.value = s.src; if (sel.value !== s.src) sel.value = ''; });
    $('slots').querySelectorAll('.num').forEach(b => b.onclick = () => { st.active = Number(b.dataset.i); renderSlots(); renderSettings(); });
    $('slots').querySelectorAll('select').forEach(sel => sel.onchange = () => {
      const i = Number(sel.dataset.i);
      setSlot(i, sel.value);
      st.active = i; renderSlots(); renderSettings();
    });
    $('selPrio').value = String(st.priority);
    $$('.slotlbl').forEach(el => el.textContent = `— configuration ${st.active + 1}${slot().label ? `: ${slot().label}` : ' (empty)'}${st.active >= Math.max(1, st.rc.length) ? ' · not on this reader' : ''}`);
  }
  $('selPrio').onchange = () => { st.priority = Number($('selPrio').value); log(`High priority card: configuration ${st.priority}`); };
  function setSlot(i, src) {
    if (!src) { st.slots[i] = newSlot(); return; }
    if (src === 'reader') { st.slots[i] = st.rc[i] ? readerSlot(i) : { ...newSlot(), src, label: 'Reader configuration', targets: {} }; return; }
    if (src.startsWith('t:')) {
      const h = src.slice(2), keep = st.slots[i].targets;
      st.slots[i] = { ...newSlot(), src, label: (window.PCX_CARD_TYPES || {})[h] || h, targets: keep, cardType: parseInt(h, 16) };
      log(`Configuration ${i + 1} card type ← ${st.slots[i].label} (${h})`);
      return;
    }
    const [, li, ci] = src.split(':').map(Number);
    const p = st.lib[li], c = p.parsed.configs[ci];
    const targets = {};
    for (const [k, v] of Object.entries(c.settings)) if (typeof v === 'number') targets[k] = v;
    st.slots[i] = { src, label: `${p.label}${p.parsed.configs.length > 1 ? ` #${ci + 1}` : ''}`, targets, cardType: c.cardType, cardPriority: c.cardPriority, fldSepData: c.fldSepData };
    log(`Configuration ${i + 1} ← ${st.slots[i].label} (${Object.keys(targets).length} settings)`);
  }

  // ---------- settings pages ----------
  function settingCard(s) {
    const sl = slot();
    const fl = fieldsFor(s.key);
    const rv = st.rc[st.active] ? st.rc[st.active].vals[s.key] : undefined;
    const tv = sl.targets[s.key];
    const changed = rv !== undefined && tv !== undefined && Number(tv) !== Number(rv);
    const chr = PCX.CHAR_KEYS.includes(s.key) && tv !== undefined ? `key: ${esc(PCX.scancodeName(Number(tv)))}` : null;
    const meta = [rv !== undefined ? `reader ${rv}` : null, chr,
      fl.length ? `<span class="tag ok">${fl.map(x => (isBin() ? `page ${Math.floor(x.byte / 8)}.${x.byte % 8}` : `byte ${x.byte}`)).join('+')}</span>` : `<span class="tag ${tv !== undefined ? 'warn' : ''}">not mapped</span>`].filter(Boolean).join(' · ');
    const lbl = `<div class="lbl"><div class="k">${s.key}${UNIT[s.key] ? ` <span class="muted">(${UNIT[s.key]})</span>` : ''}</div><div class="d">${esc(s.desc)}</div><div class="meta">${meta}</div></div>`;
    const ctl = s.type === 'bool'
      ? `<label class="tg" title="${tv === undefined ? 'not set' : tv}"><input type="checkbox" data-k="${s.key}" ${tv ? 'checked' : ''}><span></span></label>`
      : `<div class="stp"><button data-inc="${s.key}" title="+">+</button><input type="number" min="0" data-k="${s.key}" value="${tv ?? ''}" placeholder="—"><button data-dec="${s.key}" title="−">−</button></div>`;
    return `<div class="set ${changed ? 'chg' : ''}">${s.type === 'bool' ? lbl + ctl : lbl + ctl}</div>`;
  }
  function renderSettings() {
    const f = $('fmtFilter').value.trim().toLowerCase();
    const mappedOnly = $('fmtMapped').checked;
    $$('[data-sections]').forEach(box => {
      const secs = box.dataset.sections.split(',');
      const inFormat = !!box.closest('#p-format');
      const list = PCX.SETTINGS.filter(s => secs.includes(s.section) && (!inFormat || ((!f || s.key.toLowerCase().includes(f) || s.desc.toLowerCase().includes(f)) && (!mappedOnly || fieldsFor(s.key).length))));
      box.innerHTML = list.map(settingCard).join('') || '<p class="muted small">No matching settings.</p>';
      const prev = box.previousElementSibling;
      if (prev && prev.tagName === 'H3') prev.hidden = !list.length && inFormat && (f || mappedOnly);
    });
    $$('[data-sections] [data-k]').forEach(el => el.onchange = () => {
      const k = el.dataset.k;
      if (el.type === 'checkbox') slot().targets[k] = el.checked ? 1 : 0;
      else if (el.value === '') delete slot().targets[k];
      else slot().targets[k] = Math.max(0, Math.round(Number(el.value)));
      touchSlot(); renderSettings();
    });
    const bump = (k, dir) => { const s = STEP[k] || 1; const v = Number(slot().targets[k] ?? 0) + dir * s; slot().targets[k] = Math.max(0, v); touchSlot(); renderSettings(); };
    $$('[data-inc]').forEach(b => b.onclick = () => bump(b.dataset.inc, 1));
    $$('[data-dec]').forEach(b => b.onclick = () => bump(b.dataset.dec, -1));
  }
  function touchSlot() { const s = slot(); if (!s.src) { s.src = 'custom'; s.label = 'Custom'; renderSlots(); } }
  $('fmtFilter').oninput = renderSettings;
  $('fmtMapped').onchange = renderSettings;

  // ---------- write ----------
  // Write always opens the dialog; if something blocks the write, the dialog says what.
  function showWriteBlocked(checks) {
    st.plan = null;
    $('planOut').textContent = 'Nothing can be written yet:\n\n' + checks.map(c => `${c.ok ? '✓' : '✗'} ${c.text}`).join('\n');
    $('btnExecWrite').disabled = true;
    $('planNote').textContent = 'Fix the ✗ items, then press Write again. See Tools → Mapping workbench for mapping and the write template.';
    $('writeModal').hidden = false;
  }
  $('btnWrite').onclick = guard(async () => {
    if (st.reader && !st.rc.length) {
      status('Reading configuration before write…');
      try { await readConfig(); } catch (e) { log(`Configuration: ${e.message}`, 'err'); }
    }
    const bin = isBin();
    const mapped = st.map.fields.filter(f => f.cmd === blockCmd()).length;
    const checks = [
      { ok: !!st.reader, text: st.reader ? `Reader connected (${st.reader.name})` : 'No reader connected — press Connect first' },
      { ok: st.rc.length > 0, text: st.rc.length ? `Configuration read (${st.rc.length} configuration${st.rc.length > 1 ? 's' : ''})` : 'Configuration could not be read — check the log in Test Area' },
      { ok: mapped > 0, text: mapped ? `${mapped} setting(s) mapped to reader bytes${bin ? ' (built-in map)' : ''}` : 'No settings are mapped to reader bytes yet — capture and diff in Tools → Mapping workbench' },
    ];
    if (!bin) checks.push({ ok: !!st.map.writeTemplate, text: st.map.writeTemplate ? `Write template: ${st.map.writeTemplate}` : 'No write template set (Tools → Mapping workbench, step 4)' });
    checks.push({ ok: !!st.map.writeValidated, text: st.map.writeValidated ? (bin ? 'Map marked as verified against the vendor utility' : 'Write template marked as validated')
      : (bin ? 'Map not yet verified: compare the values on Timing/Format with the vendor utility, then tick the box in Tools → Mapping workbench' : 'Write template not marked as validated on a spare reader') });
    if (!st.reader || !st.rc.length || !mapped) return showWriteBlocked(checks);

    const lines = [], parts = [];
    const n = bin ? st.rc.length : 1;
    for (let i = 0; i < n && i < st.slots.length; i++) {
      const sl = st.slots[i], rc = st.rc[i];
      const changed = {};
      for (const [k, v] of Object.entries(sl.targets)) if (fieldsFor(k).length && rc.vals[k] !== undefined && Number(v) !== Number(rc.vals[k])) changed[k] = v;
      const wantCt = st.plus && sl.cardType != null ? sl.cardType : rc.cardType;
      const wantPrio = st.plus ? (st.priority === i + 1 ? 1 : 0) : rc.prio;
      const ctChange = !!st.plus && (wantCt !== rc.cardType || wantPrio !== rc.prio);
      if (!Object.keys(changed).length && !ctChange) continue;
      const plan = !Object.keys(changed).length ? null : bin ? PCX.planBinWrite(st.map, rc.block, changed, $('chkEeprom').checked) : PCX.planWrite(st.map, rc.block, changed);
      const pre = ctChange ? [PCX.binCmd([PCX.BIN.PAGE(PCX.BIN.CARD_PAGE)]), PCX.binCmd([0, wantCt & 0xFF, (wantCt >> 8) & 0xFF, wantPrio])] : [];
      parts.push({ i, plan, pre, wantCt, wantPrio });
      lines.push(`Configuration ${i + 1}${st.plus ? ` (${cardTypeName(rc.cardType)})` : ''}:`);
      if (ctChange) lines.push(`  card type ${cardTypeName(rc.cardType)}${rc.prio ? ' [high]' : ''} → ${cardTypeName(wantCt)}${wantPrio ? ' [high]' : ''}`);
      if (plan) {
        lines.push(`  settings: ${plan.applied.map(k => `${k} ${rc.vals[k]} → ${changed[k]}`).join(', ')}`);
        plan.diffs.forEach(d => lines.push(`  ${bin ? `page ${Math.floor(d.byte / 8)} pos ${d.byte % 8}` : `byte ${d.byte}`}: ${PCX.hex2(d.a)} → ${PCX.hex2(d.b)}`));
      }
      const reps = [...(st.plus ? [PCX.toHex(PCX.binCmd(PCX.BIN.selectConfig(i))) + '   (select configuration)'] : []), ...pre.map(r => PCX.toHex(r)), ...(plan ? plan.commands : [])];
      if (!bin && !st.map.writeTemplate) lines.push('  (no commands — set a write template in Tools → Mapping workbench)');
      reps.forEach(c => lines.push(`    ${c}${bin ? '' : '<CR>'}`));
      lines.push('');
    }
    if (!parts.length) lines.push('No mapped setting, card type or priority differs from the reader — nothing to write.');
    const unwritable = [...new Set(st.slots.flatMap(sl => Object.keys(sl.targets).filter(k => !fieldsFor(k).length)))];
    if (unwritable.length) lines.push('', `Not writable (no known byte): ${unwritable.slice(0, 10).join(', ')}${unwritable.length > 10 ? '…' : ''}`);
    const extra = st.slots.slice(n).filter(x => x.src).length;
    if (extra) lines.push('', `${extra} filled slot(s) beyond the reader's ${n} configuration(s) are not written.`);
    st.plan = parts.length ? { parts } : null;
    $('planOut').textContent = lines.join('\n');
    const nCmds = parts.reduce((t, p) => t + p.pre.length + (p.plan ? p.plan.commands.length : 0), 0);
    const ok = !!(nCmds && st.map.writeValidated && (bin || st.map.writeTemplate));
    $('btnExecWrite').disabled = !ok;
    $('planNote').textContent = !parts.length ? '' : (!bin && !st.map.writeTemplate) ? 'Writing is disabled until a write template is set.'
      : !st.map.writeValidated ? (bin ? 'Writing is disabled until you confirm the read values match the vendor utility (Tools → Mapping workbench).' : 'Writing is disabled until the template is marked as validated.')
      : 'After writing, the reader is re-read and every changed byte is verified.';
    $('writeModal').hidden = false;
  });
  $('chkEeprom').onchange = () => { if (!$('writeModal').hidden) $('btnWrite').click(); };
  $('btnPlanCancel').onclick = () => { $('writeModal').hidden = true; };
  $('btnExecWrite').onclick = guard(async () => {
    const plan = st.plan; const r = need();
    if (!plan) return;
    if (!confirm(`Write ${plan.parts.length} configuration(s) to ${r.name}? These readers control physical access.`)) return;
    $('btnExecWrite').disabled = true;
    status('Writing…');
    for (const p of plan.parts) {
      if (isBin()) {
        if (st.plus) await selectConfig(p.i);
        const reps = [...p.pre, ...(p.plan ? p.plan.reports : [])];
        await r.binSequence(reps);
        reps.forEach(x => log(`WRITE cfg ${p.i + 1}: ${PCX.toHex(x)}`));
      } else for (const c of p.plan.commands) {
        const res = await r.command(c, { pollReads: 3 });
        log(`WRITE ${c} → ${res.text || '(no reply)'}`);
      }
    }
    if (isBin() && st.plus) await selectConfig(st.plus.active);
    plan.parts.forEach(p => { const sl = st.slots[p.i]; if (sl) sl.src = 'reader'; });
    await readConfig();
    const bad = [];
    for (const p of plan.parts) {
      const rc = st.rc[p.i];
      if (p.plan) p.plan.diffs.forEach(d => { if (rc.block[d.byte] !== p.plan.next[d.byte]) bad.push(`cfg ${p.i + 1} byte ${d.byte} (want ${PCX.hex2(p.plan.next[d.byte])}, got ${PCX.hex2(rc.block[d.byte] ?? 0)})`); });
      if (p.pre.length && (rc.cardType !== p.wantCt || rc.prio !== p.wantPrio)) bad.push(`cfg ${p.i + 1} card type/priority`);
    }
    $('writeModal').hidden = true;
    if (bad.length) log(`Verify FAILED: ${bad.join(', ')}`, 'err');
    else {
      log(`Verified: ${plan.parts.length} configuration(s) read back correctly${isBin() && !$('chkEeprom').checked ? ' (not saved to EEPROM — lost on unplug)' : ''}`);
      status('Write verified');
      if (isBin()) r.bin(PCX.BIN.beep(1, false)).catch(() => {});
      else r.command(PCX.beepCommand(1, false), { pollReads: 1 }).catch(() => {});
    }
  });

  // ---------- card reading (Test Area) ----------
  const s0val = (k, d) => st.slots[0].targets[k] ?? (st.rc[0] && st.rc[0].vals[k]) ?? d;
  function handleCard(bytes, src, bitsOverride) {
    const now = performance.now();
    const ex = PCX.extractCardId(bytes, st.map.layout);
    const bits = bitsOverride ?? ex.bits, idBytes = ex.idBytes;
    const hold = Number(s0val('iIDHoldTO', 1000)) || 1000;
    if (!idBytes.length || idBytes.every(b => b === 0)) { if (st.card && now - st.card.seen >= hold) st.card = null; return; }
    const key = PCX.toHex(idBytes, '');
    if (st.card && st.card.key === key && now - st.card.seen < hold) { st.card.seen = now; return; }
    st.card = { key, seen: now };
    let v = PCX.bytesToBigInt(idBytes, false);
    if (bits && bits <= idBytes.length * 8) v &= (1n << BigInt(bits)) - 1n;
    let split = '—';
    if (bits && bits <= 64) {
      // binary protocol: the reader has already stripped parity, so split the data bits directly
      const s = isBin() ? PCX.splitWiegand(v, bits, 0, 0, Number(s0val('iIDBitCnt', 16)))
        : PCX.splitWiegand(v, bits, Number(s0val('iLeadParityBitCnt', 1)), Number(s0val('iTrailParityBitCnt', 1)), Number(s0val('iIDBitCnt', 16)));
      if (s) split = `${s.fac} / ${s.id}`;
    }
    $('cardBig').textContent = `${v}  ·  ${bits ?? '?'} bits`;
    $('cardBig').className = 'cardbig hit';
    const tb = $('cardTable').tBodies[0];
    tb.insertAdjacentHTML('afterbegin', `<tr><td>${new Date().toLocaleTimeString()}</td><td>${bits ?? '?'}</td><td class="mono">${esc(v.toString(16).toUpperCase())}</td><td class="mono">${split}</td></tr>`);
    while (tb.rows.length > 50) tb.deleteRow(-1);
    log(`Card (${src}): ${bits ?? '?'} bits, ${v.toString(16).toUpperCase()} · raw ${PCX.toHex(bytes)}`);
    status(`Card read: ${v} (${bits ?? '?'} bits)`);
  }
  function startListening() {
    st.listening = true; $('btnCardListen').textContent = 'Stop listening';
    if (isBin()) {
      // 0x8F = card data buffer, 0x8E = bit count; polled no faster than every 235 ms
      st.pollTimer = setInterval(async () => {
        const now = performance.now();
        if (!st.reader || st.polling || now - st.lastPoll < PCX.POLL_THROTTLE_MS) return;
        st.lastPoll = now; st.polling = true;
        try {
          const data = await st.reader.bin([PCX.BIN.CARD_DATA]);
          if (data.every(b => b === 0)) handleCard(data, 'poll', 0);
          else { const info = await st.reader.bin([PCX.BIN.CARD_INFO]); handleCard(data, 'poll', info[0]); }
        } catch (e) { log(`Card poll: ${e.message}`, 'err'); stopListening(); }
        finally { st.polling = false; }
      }, 50);
      log('Listening for cards (polling 0x8F/0x8E every ≥235 ms). Tip: with bHaltKBSnd = 0 the reader also types the ID as keystrokes.');
      return;
    }
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
  $('btnCardListen').onclick = () => { if (!st.reader) return log('Connect a reader first', 'err'); st.listening ? stopListening() : startListening(); };
  $('btnCardClear').onclick = () => { $('cardTable').tBodies[0].innerHTML = ''; st.card = null; $('cardBig').textContent = '—'; $('cardBig').className = 'cardbig muted'; };
  $('btnSimTap').onclick = () => { if (!st.listening) startListening(); st.reader.tap(Math.floor(Math.random() * 255), Math.floor(Math.random() * 65535)); };

  // ---------- presets & files ----------
  const bundle = window.PCX_PRESETS || { manifest: [], files: {} };
  async function loadLibrary() {
    let m = null;
    try { const r = await fetch('presets/manifest.json', { cache: 'no-cache' }); if (r.ok) m = await r.json(); } catch (_) {}
    m = m || bundle.manifest;
    for (const p of m) {
      let text = null;
      try { const r = await fetch('presets/' + encodeURIComponent(p.file), { cache: 'no-cache' }); if (r.ok) text = await r.text(); } catch (_) {}
      if (text == null) text = bundle.files[p.file];
      if (text == null) continue;
      try { st.lib.push({ file: p.file, label: p.label + (p.file.endsWith('+') ? ' (hwg+)' : ''), parsed: PCX.parseHwg(text) }); } catch (e) { log(`${p.file}: ${e.message}`, 'warn'); }
    }
    renderLibrary(); renderSlots();
  }
  function renderLibrary() { $('presetSel').innerHTML = st.lib.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join(''); }
  function loadIntoSlots(li, startSlot) {
    const p = st.lib[li];
    const n = Math.min(p.parsed.configs.length, 4 - startSlot);
    for (let ci = 0; ci < n; ci++) setSlot(startSlot + ci, `p:${li}:${ci}`);
    if (p.parsed.configs.length > n) log(`${p.label}: ${p.parsed.configs.length - n} configuration(s) did not fit in the remaining slots`, 'warn');
    st.active = startSlot; st.lastFile = li;
    renderSlots(); renderSettings(); renderPresetTable();
    status(`Loaded ${p.label}`);
  }
  $('btnLoadPreset').onclick = guard(() => { if ($('presetSel').value !== '') loadIntoSlots(Number($('presetSel').value), Number($('presetSlot').value)); });
  $('fileIn').onchange = guard(async () => {
    const f = $('fileIn').files[0]; if (!f) return;
    const parsed = PCX.parseHwg(await f.text()); $('fileIn').value = '';
    if (!parsed.configs.length) throw new Error(`${f.name}: no configuration found`);
    st.lib.push({ file: f.name, label: `${f.name} (opened)`, parsed });
    renderLibrary(); $('presetSel').value = String(st.lib.length - 1);
    loadIntoSlots(st.lib.length - 1, Number($('presetSlot').value));
    log(`Opened ${f.name}: ${parsed.format}, ${parsed.configs.length} configuration(s)`);
  });
  function renderPresetTable() {
    const li = st.lastFile; $('presetView').hidden = li == null;
    if (li == null) return;
    const p = st.lib[li], cfg = p.parsed.configs[0];
    const warn = [];
    if (cfg.legacy) warn.push('Legacy positional .hwg: the position→setting mapping is a best guess (first 19 positions). Remaining positions are kept raw and not applied.');
    if (p.parsed.configs.some(c => c.fldSepData)) warn.push('Contains field-separator data (sFldSepData). No confirmed command writes it, so it is not applied.');
    if (p.parsed.configs.length > 1) warn.push(`${p.parsed.configs.length} configurations (card types) — loaded into consecutive slots. Only slot 1 can be written.`);
    $('presetWarn').innerHTML = warn.map(esc).join('<br>'); $('presetWarn').hidden = !warn.length;
    const rows = Object.entries(cfg.settings).map(([k, v]) => {
      const rv = st.readerVals[k];
      return `<tr class="${rv !== undefined && Number(rv) !== Number(v) ? 'chg' : ''}"><td>${esc(k)}</td><td class="mono">${esc(v)}</td><td class="mono">${rv ?? '—'}</td><td>${fieldsFor(k).length ? '<span class="tag ok">yes</span>' : '<span class="tag">no map</span>'}</td></tr>`;
    });
    const unk = Object.entries(cfg.unknown).map(([k, v]) => `<tr><td class="muted">${esc(k)}</td><td class="mono muted">${esc(JSON.stringify(v))}</td><td>—</td><td><span class="tag">raw</span></td></tr>`);
    $('presetTable').tBodies[0].innerHTML = rows.concat(unk).join('');
  }

  const download = (name, text, type = 'text/plain') => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  function slotSettings(i) {
    const s = st.slots[i], out = {}, fromTargets = [];
    for (const d of PCX.SETTINGS) {
      const rv = st.rc[i] && s.src === 'reader' ? st.rc[i].vals[d.key] : undefined;
      if (rv !== undefined) out[d.key] = rv;
      else if (s.targets[d.key] !== undefined) { out[d.key] = s.targets[d.key]; if (s.src === 'reader') fromTargets.push(d.key); }
    }
    const cardPriority = s.cardType != null ? (st.priority === i + 1 ? 1 : 0) : s.cardPriority;
    return { settings: out, fromTargets, cardType: s.cardType, cardPriority, fldSepData: s.fldSepData || null };
  }
  function exportHwg(allSlots) {
    const idx = allSlots ? st.slots.map((s, i) => (s.src ? i : -1)).filter(i => i >= 0) : [st.active];
    const cfgs = idx.map(slotSettings).filter(c => Object.keys(c.settings).length);
    if (!cfgs.length) throw new Error('Nothing to save — read the reader (with a field map) or load a preset first');
    let text = PCX.serializeHwgPlus(cfgs, { libVersion: 'pcProx Portal (WebHID)', fwVersion: st.fw || 'unknown' });
    const ft = cfgs.flatMap(c => c.fromTargets);
    if (ft.length) text = text.replace(/\r\n\r\n/, `\r\n/ NOTE: not read from the reader (unmapped): ${ft.join(', ')}\r\n\r\n`);
    download(allSlots ? 'device-data.hwg+' : `configuration-${st.active + 1}.hwg+`, text);
    log(`Saved ${cfgs.length} configuration(s) to .hwg+`); status('Saved .hwg+ file');
  }
  function exportCapture() {
    const r = need();
    download(`capture-${r.vidpid.replace(':', '-')}-${Date.now()}.json`, JSON.stringify({
      tool: 'pcProx Portal (WebHID)', time: new Date().toISOString(),
      device: { name: r.name, vidpid: r.vidpid, kind: r.kind, reportId: r.reportId, reportLen: r.reportLen, collections: r.describe() },
      firmware: st.fw, qrz: st.qrz ? PCX.toHex(st.qrz, '') : null,
      snapshots: st.snapshots.map(s => ({ label: s.label, cmd: s.cmd, time: s.time, reply: s.text, hex: PCX.toHex(s.bytes, '') })), map: st.map,
    }, null, 2), 'application/json');
    status('Saved raw capture');
  }
  const exportMap = () => download(`fieldmap-${st.map.vidpid.replace(':', '-')}.json`, JSON.stringify(st.map, null, 2), 'application/json');
  $('btnExportHwg').onclick = guard(() => exportHwg(false));
  $('btnExportCapture').onclick = guard(exportCapture);

  // ---------- mapping workbench ----------
  function renderQrz() {
    $('qrzView').hidden = !st.qrz;
    if (!st.qrz) return;
    $('qrzLen').textContent = `${st.qrz.length} bytes`;
    const mapped = new Map();
    for (const f of st.map.fields) if (f.cmd === blockCmd()) for (let i = 0; i < f.width; i++) mapped.set(f.byte + i, (mapped.get(f.byte + i) || []).concat(f.key));
    $('qrzBytes').innerHTML = Array.from(st.qrz, (b, i) => {
      const m = mapped.get(i);
      return `<div class="byte ${m ? 'mapped' : ''} ${!isBin() && i < 5 ? 'conf' : ''}" title="${esc(m ? m.join(', ') : !isBin() && i < 5 ? 'confirmed decode' : 'unmapped')}"><i>${isBin() ? `p${Math.floor(i / 8)}.${i % 8}` : i}</i>${PCX.hex2(b)}</div>`;
    }).join('');
    const c = isBin() ? null : PCX.decodeQRZConfirmed(st.qrz);
    $('qrzConfirmed').closest('details').hidden = isBin();
    $('qrzConfirmed').innerHTML = c ? '<tr><th>Byte</th><th>Op</th><th>Value</th><th>Meaning</th></tr>' + c.map(r => `<tr><td>${r.byte}</td><td><code>${esc(r.op)}</code></td><td>${r.value} (${hx(r.value)})</td><td>${esc(r.meaning)}</td></tr>`).join('') : '<tr><td>Block shorter than 5 bytes</td></tr>';
  }
  $('fmKey').innerHTML = PCX.SETTINGS.map(s => `<option>${s.key}</option>`).join('');
  $('btnSnap').onclick = guard(async () => {
    const cmd = $('snapCmd').value;
    let p;
    if (cmd === 'CFG') { const b = await readBlock(viewIdx()); p = { bytes: b, text: PCX.toHex(b) }; }
    else if (isBin()) {
      const code = cmd === 'DEV' ? [PCX.BIN.DEVINFO] : PCX.BIN.EXTRA[cmd];
      const b = await need().bin(code); p = { bytes: b, text: PCX.toHex(b) };
    } else p = await query(cmd);
    const snap = { id: ++st.snapSeq, cmd, label: $('snapLabel').value.trim() || `${cmd} #${st.snapSeq}`, bytes: p.bytes || new Uint8Array(0), text: p.text, time: new Date().toISOString() };
    st.snapshots.push(snap);
    if (cmd === blockCmd() && st.rc.length) { st.qrz = snap.bytes; recomputeReaderVals(); renderQrz(); renderSettings(); }
    if (st.selA == null) st.selA = snap.id; else st.selB = snap.id;
    $('snapLabel').value = '';
    renderSnaps(); renderDiff();
  });
  function renderSnaps() {
    $('snapTable').tBodies[0].innerHTML = st.snapshots.map(s => `<tr>
      <td><input type="radio" name="snapA" value="${s.id}" ${st.selA === s.id ? 'checked' : ''}></td>
      <td><input type="radio" name="snapB" value="${s.id}" ${st.selB === s.id ? 'checked' : ''}></td>
      <td>${esc(s.label)}</td><td>${s.cmd}</td><td class="mono small">${PCX.toHex(s.bytes)}</td>
      <td><button class="x" data-del="${s.id}">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">No snapshots yet.</td></tr>';
    $$('[name=snapA]').forEach(r => r.onchange = () => { st.selA = Number(r.value); renderDiff(); });
    $$('[name=snapB]').forEach(r => r.onchange = () => { st.selB = Number(r.value); renderDiff(); });
    $$('[data-del]').forEach(b => b.onclick = () => {
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
      <td><button class="btn" data-use="${x.byte}" data-mask="${x.bits}">Use</button></td></tr>`;
    }).join('')}</table>${d.length === 2 && d[1].byte === d[0].byte + 1 ? '<p class="muted small">Two adjacent bytes changed — this may be one 16-bit field (width 2, mask FFFF).</p>' : ''}`;
    out.querySelectorAll('[data-use]').forEach(b => b.onclick = () => {
      const mask = Number(b.dataset.mask);
      const sh = tz(mask), hi = 31 - Math.clz32(mask), span = ((1 << (hi - sh + 1)) - 1) << sh;
      $('fmCmd').value = A.cmd; $('fmByte').value = b.dataset.use; $('fmWidth').value = '1';
      $('fmMask').value = span.toString(16).toUpperCase(); $('fmShift').value = sh;
      $('fmNote').value = `${A.label} → ${B.label}`; $('fmKey').focus();
    });
  }
  $('fmWidth').onchange = () => { $('fmMask').value = $('fmWidth').value === '2' ? 'FFFF' : 'FF'; $('fmShift').value = 0; };
  function rangesOverlap(a, b) {
    const bitsOf = f => { const s = new Set(); for (let i = 0; i < f.width * 8; i++) if (f.mask & (1 << i)) s.add((f.byte + f.width - 1 - Math.floor(i / 8)) * 8 + (i % 8)); return s; };
    const A = bitsOf(a); for (const x of bitsOf(b)) if (A.has(x)) return true; return false;
  }
  const refreshAll = () => { recomputeReaderVals(); renderMapUi(); renderQrz(); renderSettings(); renderPresetTable(); };
  $('btnAddField').onclick = guard(() => {
    if (!st.reader) throw new Error('Connect a reader first — field maps are saved per reader model');
    const f = { key: $('fmKey').value, cmd: $('fmCmd').value, byte: Number($('fmByte').value), width: Number($('fmWidth').value), mask: parseInt($('fmMask').value, 16), shift: Number($('fmShift').value), scale: Math.max(1, Number($('fmScale').value) || 1), note: $('fmNote').value.trim() };
    PCX.validateField(f);
    const clash = st.map.fields.find(x => x.cmd === f.cmd && x.key !== f.key && rangesOverlap(x, f));
    if (clash && !confirm(`${clash.key} already uses overlapping bits of byte ${clash.byte}. Add anyway?`)) return;
    st.map.fields = st.map.fields.filter(x => !(x.key === f.key && x.cmd === f.cmd && x.byte === f.byte));
    st.map.fields.push(f);
    persistMap(); recomputeReaderVals();
    st.rc.forEach((c, i) => { const sl = st.slots[i]; if (sl) for (const [k, v] of Object.entries(c.vals)) if (!(k in sl.targets)) sl.targets[k] = v; });
    refreshAll();
    log(`Mapped ${f.key} → ${f.cmd} byte ${f.byte}${f.width === 2 ? '-' + (f.byte + 1) : ''} mask ${hx(f.mask)} >>${f.shift}`);
    $('fmNote').value = '';
  });
  function renderMapUi() {
    const m = st.map;
    $('fieldTable').tBodies[0].innerHTML = m.fields.slice().sort((a, b) => a.byte - b.byte).map(f => `<tr><td>${esc(f.key)}</td><td>${f.cmd}</td><td>${f.byte}</td><td>${f.width}</td><td class="mono">${hx(f.mask)}</td><td>${f.shift}${f.scale > 1 ? ` ×${f.scale}` : ''}</td><td class="muted small">${esc(f.note)}</td>
      <td><button class="x" data-rm="${esc(f.key)}|${f.cmd}|${f.byte}">✕</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No fields mapped yet.</td></tr>';
    $('fieldTable').querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const [k, c, by] = b.dataset.rm.split('|');
      m.fields = m.fields.filter(f => !(f.key === k && f.cmd === c && f.byte === Number(by)));
      persistMap(); refreshAll();
    });
    $('fmTemplate').value = m.writeTemplate; $('fmValidated').checked = !!m.writeValidated;
    $('lyBits').value = m.layout.bitCountByte; $('lyStart').value = m.layout.idStart; $('lyLen').value = m.layout.idLen; $('lyRev').value = m.layout.reverse ? '1' : '0';
    $('lyPoll').value = m.pollCommand || '';
  }
  function persistMap() {
    if (!st.reader) return;
    $('mapStatus').textContent = PCX.saveMap(st.map) ? `Saved for ${st.map.vidpid} in this browser` : 'Browser storage unavailable — export the map to keep it';
  }
  $('fmTemplate').onchange = guard(() => {
    const t = $('fmTemplate').value.trim();
    if (t) PCX.renderWrite(t, new Uint8Array(4), [{ byte: 0, a: 0, b: 1 }]); // syntax check
    st.map.writeTemplate = t; st.map.writeValidated = false; $('fmValidated').checked = false;
    persistMap(); log(`Write template set to "${t || '(none)'}" — not validated`);
  });
  $('fmValidated').onchange = () => {
    if ($('fmValidated').checked && !isBin() && !st.map.writeTemplate) { $('fmValidated').checked = false; return log('Set a write template first', 'warn'); }
    if ($('fmValidated').checked && !confirm(isBin()
      ? 'Confirm the values shown on Timing and Format match what the vendor utility shows for this reader. (Best: also save a backup .hwg+ from the vendor utility first.)'
      : 'Confirm you have validated this write template (write, re-read, diff) on a reader you can safely re-flash.')) { $('fmValidated').checked = false; return; }
    st.map.writeValidated = $('fmValidated').checked; persistMap();
  };
  ['lyBits', 'lyStart', 'lyLen', 'lyRev', 'lyPoll'].forEach(id => $(id).onchange = () => {
    st.map.layout = { bitCountByte: Number($('lyBits').value), idStart: Number($('lyStart').value), idLen: Number($('lyLen').value), reverse: $('lyRev').value === '1' };
    st.map.pollCommand = $('lyPoll').value.trim();
    persistMap();
    if (st.listening) { stopListening(); startListening(); }
  });
  $('btnExportMap').onclick = exportMap;
  $('mapFile').onchange = guard(async () => {
    const f = $('mapFile').files[0]; if (!f) return;
    const j = JSON.parse(await f.text()); $('mapFile').value = '';
    if (j.version !== 1 || !Array.isArray(j.fields)) throw new Error('Not a field map file');
    j.fields.forEach(PCX.validateField);
    if (j.vidpid && j.vidpid !== st.map.vidpid && !confirm(`This map was made for ${j.vidpid}, the reader is ${st.map.vidpid}. Import anyway?`)) return;
    st.map = Object.assign(PCX.defaultMap(st.map.vidpid), j, { vidpid: st.map.vidpid, writeValidated: false });
    persistMap(); refreshAll();
    log(`Imported field map: ${st.map.fields.length} field(s). Re-confirm the write template before writing.`);
  });
  $('btnClearMap').onclick = () => {
    if (!confirm('Clear the field map for this reader model?')) return;
    st.map = PCX.defaultMap(st.map.vidpid); persistMap(); refreshAll();
  };

  // ---------- SDK ----------
  $('conQuick').innerHTML = PCX.COMMANDS.filter(c => c.dir === 'read').map(c => `<button class="btn" data-q="${c.cmd}" title="${esc(c.desc)}">${c.cmd}</button>`).join('');
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
  $('btnSecure').onclick = guard(async () => {
    const r = need();
    const frame = PCX.secureReadFrame($('secParams').value, r.reportLen);
    const resp = await r.rawExchange(frame);
    $('secOut').textContent = `TX ${PCX.toHex(frame)}\nRX ${PCX.toHex(resp)}\n   |${asciiOf(resp)}|`;
  });

  $('btnLogClear').onclick = () => { $('log').textContent = ''; };
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { fab(false); closeMenus(); $('writeModal').hidden = true; } });

  applyProtocol(false);
  loadLibrary();
  window.PCX_STATE = st; // for troubleshooting from the browser console
  log('Portal ready. Connect a reader, or try the simulated reader.');
})();
