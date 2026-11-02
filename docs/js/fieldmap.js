/* Field map: which byte (and bits) of a query block holds which named setting, and how
 * to write it back. Per the reference, everything past QRZ bytes 0-4 and the whole write
 * layout are Runtime-confirm, so the map starts empty and is built from captured diffs. */
(function (root) {
  'use strict';
  const PCX = root.PCX = root.PCX || {};
  const KEY = 'pcx.fieldmap.v1.';

  PCX.defaultMap = vidpid => ({
    version: 1,
    vidpid,
    fields: [],            // { key, cmd, byte, width: 1|2, mask, shift, note }
    writeTemplate: '',     // e.g. "SL0{ADDR}{VAL}" or "FR{OFFSET}{DATA}" — must be validated on hardware
    writeValidated: false, // user attests the template was validated on a re-flashable reader
    layout: { bitCountByte: 0, idStart: 1, idLen: 8, reverse: false }, // card ID report layout
    pollCommand: '',       // optional command polled for the active ID (blank = input reports only)
  });

  // protocol: 'bin' (8-byte binary, built-in map) or 'ascii' (24-byte reference-doc protocol, map from diffs)
  PCX.loadMap = (vidpid, protocol = 'bin') => {
    let m = PCX.defaultMap(vidpid), j = null;
    try { j = JSON.parse(localStorage.getItem(KEY + protocol + '.' + vidpid) || 'null'); } catch (_) {}
    if (j && j.version === 1) m = Object.assign(m, j, { vidpid });
    m.protocol = protocol;
    if (protocol === 'bin') {
      // built-in fields first; user additions/overrides on top
      const own = m.fields.filter(f => !f.builtin);
      m.fields = PCX.BUILTIN_FIELDS.filter(b => !own.some(o => o.key === b.key)).map(f => ({ ...f })).concat(own);
      // card buffer 0 is the ID itself, little-endian; bit count comes from buffer 1
      if (!(j && j.layout)) m.layout = { bitCountByte: -1, idStart: 0, idLen: 8, reverse: true };
    }
    return m;
  };
  PCX.saveMap = map => { try { localStorage.setItem(KEY + (map.protocol || 'bin') + '.' + map.vidpid, JSON.stringify(map)); return true; } catch (_) { return false; } };

  // Binary write plan: for each changed page -> [0x80|p] then the 8 page bytes; finally [0x90, saveMask].
  PCX.planBinWrite = (map, block, targets, saveToEeprom = true) => {
    let next = Uint8Array.from(block);
    const applied = [], skipped = [];
    for (const [key, value] of Object.entries(targets)) {
      const fields = map.fields.filter(f => f.key === key && f.cmd === 'CFG');
      if (!fields.length) { skipped.push(key); continue; }
      for (const f of fields) next = PCX.injectField(next, f, value);
      applied.push(key);
    }
    const diffs = PCX.diffBlocks(block, next);
    const pages = [...new Set(diffs.map(d => Math.floor(d.byte / 8)))].sort();
    const reports = [];
    let mask = 0;
    for (const p of pages) {
      reports.push(PCX.binCmd([PCX.BIN.PAGE(p)]));
      reports.push(next.slice(p * 8, p * 8 + 8));
      mask |= 1 << p;
    }
    if (pages.length) reports.push(PCX.binCmd([PCX.BIN.FINISH, saveToEeprom ? mask : 0]));
    return { next, diffs, applied, skipped, pages, reports, commands: reports.map(r => PCX.toHex(r)) };
  };

  PCX.validateField = f => {
    if (!f.key) throw new Error('Field needs a setting name');
    if (!Number.isInteger(f.byte) || f.byte < 0) throw new Error('Byte offset must be a non-negative integer');
    if (![1, 2].includes(f.width)) throw new Error('Width must be 1 or 2 bytes');
    const max = f.width === 2 ? 0xFFFF : 0xFF;
    if (!Number.isInteger(f.mask) || f.mask <= 0 || f.mask > max) throw new Error('Mask out of range');
    if (!Number.isInteger(f.shift) || f.shift < 0 || f.shift > 15) throw new Error('Shift out of range');
    if (f.scale != null && !(Number(f.scale) > 0)) throw new Error('Scale must be positive');
    return true;
  };

  PCX.extractField = (block, f) => {
    if (!block || f.byte + f.width > block.length) return undefined;
    const raw = f.width === 2 ? (block[f.byte] << 8) | block[f.byte + 1] : block[f.byte];
    return ((raw & f.mask) >>> f.shift) * (f.scale || 1);
  };

  PCX.injectField = (block, f, value) => {
    const out = Uint8Array.from(block);
    if (f.byte + f.width > out.length) throw new Error(`${f.key}: byte ${f.byte} is outside the ${out.length}-byte block`);
    const max = f.mask >>> f.shift;
    const scale = f.scale || 1;
    const v = Math.round(Number(value) / scale);
    if (!Number.isInteger(v) || v < 0 || v > max) throw new Error(`${f.key}: value ${value} is out of range (0..${max * scale}${scale > 1 ? `, steps of ${scale}` : ''})`);
    let raw = f.width === 2 ? (out[f.byte] << 8) | out[f.byte + 1] : out[f.byte];
    raw = (raw & ~f.mask) | ((v << f.shift) & f.mask);
    if (f.width === 2) { out[f.byte] = (raw >> 8) & 0xFF; out[f.byte + 1] = raw & 0xFF; } else out[f.byte] = raw & 0xFF;
    return out;
  };

  // Bit-level diff between two blocks.
  PCX.diffBlocks = (a, b) => {
    const n = Math.max(a.length, b.length), out = [];
    for (let i = 0; i < n; i++) {
      const x = a[i], y = b[i];
      if (x !== y) out.push({ byte: i, a: x, b: y, bits: (x ?? 0) ^ (y ?? 0) });
    }
    return out;
  };

  // Build the write plan: target settings -> new block -> commands, via the template.
  PCX.planWrite = (map, block, targets) => {
    let next = Uint8Array.from(block);
    const applied = [], skipped = [];
    for (const [key, value] of Object.entries(targets)) {
      const fields = map.fields.filter(f => f.key === key && f.cmd === 'QRZ');
      if (!fields.length) { skipped.push(key); continue; }
      for (const f of fields) next = PCX.injectField(next, f, value);
      applied.push(key);
    }
    const diffs = PCX.diffBlocks(block, next);
    const commands = PCX.renderWrite(map.writeTemplate, next, diffs);
    return { next, diffs, applied, skipped, commands };
  };

  /* Template placeholders:
   *   {ADDR} {VAL}     per changed byte, two hex digits each (one command per byte)
   *   {OFFSET} {DATA}  chunked contiguous runs (DATA = hex bytes), split to fit the report
   *   {LEN}            byte count of the chunk (two hex digits) */
  PCX.renderWrite = (tpl, next, diffs, reportLen = PCX.REPORT_LEN) => {
    if (!tpl || !diffs.length) return [];
    const room = reportLen - 1; // CR
    if (/\{DATA\}/.test(tpl)) {
      const overhead = tpl.replace(/\{DATA\}/g, '').replace(/\{OFFSET\}|\{LEN\}/g, 'XX').length;
      const perCmd = Math.floor((room - overhead) / 2);
      if (perCmd < 1) throw new Error('Write template leaves no room for data in a 24-byte report');
      // group changed bytes into contiguous runs
      const runs = [];
      for (const d of diffs) {
        const r = runs[runs.length - 1];
        if (r && d.byte === r.start + r.len) r.len++; else runs.push({ start: d.byte, len: 1 });
      }
      const cmds = [];
      for (const r of runs) {
        for (let o = r.start; o < r.start + r.len; o += perCmd) {
          const n = Math.min(perCmd, r.start + r.len - o);
          cmds.push(tpl.replace(/\{OFFSET\}/g, PCX.hex2(o)).replace(/\{LEN\}/g, PCX.hex2(n))
            .replace(/\{DATA\}/g, PCX.toHex(next.slice(o, o + n), '')));
        }
      }
      return cmds;
    }
    if (!/\{ADDR\}|\{VAL\}/.test(tpl)) throw new Error('Write template must contain {ADDR}/{VAL} or {DATA}');
    return diffs.map(d => {
      const c = tpl.replace(/\{ADDR\}/g, PCX.hex2(d.byte)).replace(/\{VAL\}/g, PCX.hex2(next[d.byte]));
      if (c.length > room) throw new Error(`Command "${c}" is too long for the report`);
      return c;
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
