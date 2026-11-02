/* pcProx protocol layer — pure functions, no DOM, no device I/O.
 * Source of truth: "rf IDeas pcProx — USB HID & Configuration Protocol Reference.md".
 * Items marked RUNTIME-CONFIRM in that reference are never hard-coded here as facts. */
(function (root) {
  'use strict';
  const PCX = root.PCX = root.PCX || {};

  // ---------- Device identity (Confirmed) ----------
  PCX.VENDOR_IDS = [0x0C27, 0x19E5];
  PCX.MODELS = {
    '0C27:3B4C': 'RF IDeas HID CDC',
    '0C27:3B1E': 'RF IDeas BLE',
    '0C27:3B57': 'RF IDeas Wiegand',
    '0C27:3BFB': 'RF IDeas ProxAdv',
    '0C27:3BFA': 'RF IDeas (ProxAdv variant)',
    '0C27:CCDA': 'RF IDeas CCID',
    '0C27:3A01': 'RF IDeas KPIT',
    '19E5:2021': 'RF IDeas JM3',
  };
  const h4 = n => n.toString(16).toUpperCase().padStart(4, '0');
  PCX.vidpid = (vid, pid) => `${h4(vid)}:${h4(pid)}`;
  PCX.modelName = (vid, pid) => PCX.MODELS[PCX.vidpid(vid, pid)] || 'Unknown rf IDeas model';

  // ---------- Transport constants (Confirmed) ----------
  PCX.REPORT_LEN = 24;          // config/beeper command report (data bytes, report id carried separately)
  PCX.MAX_WIRE_LEN = 25;        // including report-id byte
  PCX.WRITE_RETRIES = 6;
  PCX.WRITE_RETRY_MS = 80;
  PCX.POLL_THROTTLE_MS = 235;
  PCX.CR = 0x0D;

  // ---------- Command table (Confirmed) ----------
  PCX.COMMANDS = [
    { cmd: 'QRZ', dir: 'read',    desc: 'Read main configuration block' },
    { cmd: 'QSV', dir: 'read',    desc: 'Read service / version block' },
    { cmd: 'QDD', dir: 'read',    desc: 'Read device-data block' },
    { cmd: 'QS0', dir: 'read',    desc: 'Read S0 page' },
    { cmd: 'QUP', dir: 'read',    desc: 'Read uptime / status' },
    { cmd: 'GS0', dir: 'read',    desc: 'Get S0' },
    { cmd: 'GL0', dir: 'read',    desc: 'Get L0' },
    { cmd: 'SL0', dir: 'write',   desc: 'Set L0 — followed by two hex bytes (SL0%02X%02X)' },
    { cmd: 'CD0', dir: 'write',   desc: 'Clear / command D0' },
    { cmd: 'FR',  dir: 'write',   desc: 'Feature-report write (WriteCfg USB entry)' },
    { cmd: 'BS',  dir: 'control', desc: 'Short beep + level 1..5' },
    { cmd: 'BL',  dir: 'control', desc: 'Long beep + level 1..2' },
  ];
  PCX.isWriteCommand = s => /^[SCF]/i.test(String(s).trim());

  // ---------- Hex helpers ----------
  PCX.toHex = (bytes, sep = ' ') => Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(sep);
  PCX.hexToBytes = str => {
    const clean = String(str).replace(/[^0-9a-f]/gi, '');
    if (clean.length % 2) throw new Error('Hex string has an odd number of digits');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  };
  PCX.hex2 = n => (n & 0xFF).toString(16).toUpperCase().padStart(2, '0');

  // ---------- ASCII command framing (Confirmed) ----------
  // command string + CR, zero padded to the report length.
  PCX.encodeCommand = (cmd, len = PCX.REPORT_LEN) => {
    const s = String(cmd);
    if (!/^[\x20-\x7E]*$/.test(s)) throw new Error('Commands must be printable ASCII');
    if (s.length + 1 > len) throw new Error(`Command "${s}" is ${s.length + 1} bytes with CR; the report holds ${len}`);
    const out = new Uint8Array(len);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    out[s.length] = PCX.CR;
    return out;
  };

  // Reply bytes -> ASCII text (stops at NUL, trims CR/LF).
  PCX.decodeReply = bytes => {
    let s = '';
    for (const b of bytes) { if (b === 0) break; s += String.fromCharCode(b); }
    const terminated = /\r/.test(s);
    return { text: s.replace(/[\r\n]+$/g, '').replace(/\r/g, ''), terminated, printable: /^[\x20-\x7E\r\n]*$/.test(s) };
  };

  // Q -> R acknowledgement (Confirmed for query commands).
  PCX.ackFor = cmd => {
    const c = String(cmd).trim().toUpperCase();
    return c[0] === 'Q' && c.length >= 3 ? 'R' + c.slice(1, 3) : null;
  };

  // Strip the three-character ack header and decode the ASCII-hex payload.
  PCX.parseQueryReply = (text, cmd) => {
    const ack = PCX.ackFor(cmd);
    const t = String(text).trim();
    if (!ack) return { ok: true, ack: null, payloadHex: t, bytes: null };
    if (!t.toUpperCase().startsWith(ack)) return { ok: false, ack, error: `Expected ack "${ack}", got "${t.slice(0, 8)}"` };
    const payloadHex = t.slice(3).replace(/[^0-9a-f]/gi, '');
    let bytes = null;
    try { bytes = PCX.hexToBytes(payloadHex.length % 2 ? payloadHex.slice(0, -1) : payloadHex); } catch (_) { bytes = new Uint8Array(0); }
    return { ok: true, ack, payloadHex, bytes, oddNibble: payloadHex.length % 2 === 1 };
  };

  // ---------- QRZ confirmed decode (bytes 0..4 only) ----------
  PCX.decodeQRZConfirmed = b => {
    if (!b || b.length < 5) return null;
    return [
      { byte: '0', op: '& 0x3F', value: b[0] & 0x3F, meaning: 'Lead-character / display base value' },
      { byte: '0', op: '& 0x01', value: b[0] & 0x01, meaning: 'Boolean flag bit' },
      { byte: '1', op: 'direct', value: b[1], meaning: 'Parameter byte' },
      { byte: '2,3', op: '(b2<<8)|b3', value: (b[2] << 8) | b[3], meaning: '16-bit count (e.g. a bit count)' },
      { byte: '4', op: 'direct', value: b[4], meaning: 'Parameter byte' },
    ];
  };

  // ---------- Beeper (Confirmed) ----------
  PCX.beepCommand = (level, long) => {
    const max = long ? 2 : 5;
    const lv = Math.min(max, Math.max(1, Math.round(Number(level) || 1)));
    return (long ? 'BL' : 'BS') + String.fromCharCode(0x30 + lv);
  };

  // ---------- Secure-data frame (layout Confirmed; response parsing Runtime-confirm) ----------
  // WebHID data excludes the report-id byte, so data[0] is the opcode.
  PCX.secureReadFrame = (params, len = PCX.REPORT_LEN) => {
    const p = params instanceof Uint8Array ? params : PCX.hexToBytes(params || '');
    const out = new Uint8Array(len);
    out.set([0x89, 0x10, 0x00, 0x00], 0);
    if (4 + p.length > len) throw new Error('Secure-frame parameters too long for the report');
    out.set(p, 4);
    return out;
  };

  // ---------- Card ID helpers ----------
  // Extract an ID from a raw report given a (runtime-confirmed) layout.
  PCX.extractCardId = (bytes, layout) => {
    const L = Object.assign({ bitCountByte: 0, idStart: 1, idLen: 8, reverse: false }, layout || {});
    const bits = L.bitCountByte >= 0 && L.bitCountByte < bytes.length ? bytes[L.bitCountByte] : null;
    let id = Array.from(bytes.slice(L.idStart, L.idStart + L.idLen));
    if (L.reverse) id = id.reverse();
    return { bits, idBytes: id };
  };

  // Value of the low `bits` bits of a big-endian or little-endian byte array, as BigInt.
  PCX.bytesToBigInt = (arr, littleEndian) => {
    const a = littleEndian ? [...arr].reverse() : arr;
    let v = 0n;
    for (const b of a) v = (v << 8n) | BigInt(b);
    return v;
  };

  // Wiegand-style split: strip parity, then FAC / ID by ID bit count.
  PCX.splitWiegand = (value, totalBits, leadParity, trailParity, idBits) => {
    if (!totalBits) return null;
    const mask = (1n << BigInt(totalBits)) - 1n;
    let v = value & mask;
    v >>= BigInt(trailParity || 0);
    const dataBits = totalBits - (leadParity || 0) - (trailParity || 0);
    if (dataBits <= 0) return null;
    v &= (1n << BigInt(dataBits)) - 1n;
    const idb = Math.min(idBits || dataBits, dataBits);
    const id = v & ((1n << BigInt(idb)) - 1n);
    const fac = v >> BigInt(idb);
    return { fac, id, dataBits };
  };
})(typeof window !== 'undefined' ? window : globalThis);
