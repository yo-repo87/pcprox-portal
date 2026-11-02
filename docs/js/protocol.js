/* pcProx protocol layer — pure functions, no DOM, no device I/O.
 * Source of truth: "rf IDeas pcProx — USB HID & Configuration Protocol Reference.md".
 * Items marked RUNTIME-CONFIRM in that reference are never hard-coded here as facts. */
(function (root) {
  'use strict';
  const PCX = root.PCX = root.PCX || {};

  // ---------- Device identity (Confirmed) ----------
  // VID/PIDs as listed in the vendor utility's pcProxVIDPID.txt (+ 3BFA from its DLL).
  PCX.VENDOR_IDS = [0x0C27, 0x19E5, 0x171B];
  PCX.MODELS = {
    '0C27:3BFA': 'RF IDeas pcProx (USB keyboard emulation)',
    '0C27:CCDB': 'Imprivata FIDO CCID',
    '171B:2001': 'NT-ware',
    '0C27:3B4C': 'RF IDeas HID CDC',
    '0C27:3B1E': 'RF IDeas BLE',
    '0C27:3B57': 'RF IDeas Wiegand',
    '0C27:3BFB': 'RF IDeas ProxAdv',
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

  // =====================================================================
  // Binary 8-byte feature-report protocol (pcProx USB keyboard readers).
  // Sources: the vendor DLL ("# 8 byte USB Feature Reports" in its raw-dump
  // writer) and the open-source pcprox library/protocol notes by M. Farrell,
  // tested on 0C27:3BFA (RDR-6081AKU, fw 07.3.0). Not an rf IDeas document.
  // =====================================================================
  PCX.BIN = {
    REPORT_LEN: 8,
    PAGE: p => 0x80 | p,     // select config page p for read (then GET) or write (then SET data)
    PAGES: [0, 1, 2, 3],     // config pages read/written as one 32-byte block (page 3 = extended settings)
    DEVINFO: 0x8A,           // device / firmware info
    CARD_DATA: 0x8F,         // card read buffer 0 (ID bytes, little-endian, parity stripped)
    CARD_INFO: 0x8E,         // card read buffer 1 (byte 0 = bit count of buffer 0)
    FINISH: 0x90,            // end configuration; param0 = bitmask of pages to save to EEPROM
    // extra read-only queries seen in the open-source tool (meaning unconfirmed)
    EXTRA: { P3: [0x83], P5: [0x85], C8C0: [0x8C, 0x01, 0x00], C8C1: [0x8C, 0x01, 0x01], C8C2: [0x8C, 0x01, 0x02] },
  };
  // Recovered from pcProxAPI.dll (BeepNow, SetBeeperVolume, GetBeeperVolume, PlusBlockMove,
  // SetActConfig/WriteCfg, the card-type writer and the multi-config detector). Data bytes exclude the report id.
  Object.assign(PCX.BIN, {
    beep: (n, long) => [0x8C, 0x03, (Math.min(long ? 2 : 5, Math.max(1, n | 0))) | (long ? 0x80 : 0)],
    VOLUME_GET: [0x8C, 0x06],                       // reply data[2] = 0 off, 1 low, 2 medium, 3 high
    volumeSet: lvl => [0x8C, 0x86, lvl & 3],
    PLUS_INFO: [0x89, 0x01],                        // reply [0x89, ?, activeConfig, configCount] on pcProx Plus
    selectConfig: i => [0x89, 0x81, i & 0xFF],      // reply echoes [0x89, 0x81]
    CARD_PAGE: 4,                                   // page 4 = [00, cardType lo, cardType hi, priority]
    // copy a whole memory bank: 1 = working, 2 = stored (user defaults), 3 = factory
    blockMove: (src, dst) => [0x89, 0x82, src & 7, dst & 7, 0x00, 0xFF],
    BANK: { WORKING: 1, STORED: 2, FACTORY: 3 },
    // Extended-Mode field/separator table (.hwg+ "sFldSepData"): 18 blocks of 8 bytes per configuration.
    // Select block n with [85 n 00 10], then GET it or SET its 8 data bytes; finish with 90 mask 0x20.
    FLDSEP_BLOCKS: 18,
    fldSep: n => [0x85, n & 0xFF, 0x00, 0x10],
    // 0x90 finish mask bits seen in the DLL: 01 p0, 02 p1, 04 p2, 08 p3, 20 p5, 80 LUID
  });
  PCX.binCmd = bytes => { const o = new Uint8Array(8); o.set(Array.from(bytes).slice(0, 8)); return o; };
  // Device info reply: [?, ?, {minor:4, release:4}, major, ?, deviceType(LE16), ?]
  PCX.decodeDevInfo = b => {
    if (!b || b.length < 7) return null;
    // The vendor utility prints the major version byte in hex (0x16 -> "16.9.0"), so do the same.
    const major = b[3], rel = b[2] >> 4, minor = b[2] & 0x0F;
    return { firmware: `${major.toString(16).toUpperCase().padStart(2, '0')}.${rel}.${minor}`, majorDec: major, deviceType: b[5] | (b[6] << 8) };
  };

  // Built-in field map for the binary protocol. Block = pages 0,1,2 concatenated (byte = page*8 + pos).
  // scale = reader units -> ms (time fields are stored as 4 ms / 50 ms ticks).
  const F = (key, page, pos, mask, shift = 0, scale = 1) => ({ key, cmd: 'CFG', byte: page * 8 + pos, width: 1, mask, shift, scale, note: 'built-in (open-source pcprox notes; verify on your model)', builtin: true });
  PCX.BUILTIN_FIELDS = [
    F('iFACDispLen', 0, 0, 0xFF), F('iIDDispLen', 0, 1, 0xFF),
    F('iLeadParityBitCnt', 0, 2, 0x0F), F('iTrailParityBitCnt', 0, 2, 0xF0, 4),
    F('iIDBitCnt', 0, 3, 0xFF), F('iTotalBitCnt', 0, 4, 0xFF),
    F('iFACIDDelim', 0, 5, 0xFF), F('iELDelim', 0, 6, 0xFF),
    F('bFixLenDsp', 0, 7, 0x01, 0), F('bFrcBitCntEx', 0, 7, 0x02, 1), F('bStripFac', 0, 7, 0x04, 2), F('bSndFac', 0, 7, 0x08, 3),
    F('bUseDelFac2Id', 0, 7, 0x10, 4), F('bNoUseELChar', 0, 7, 0x20, 5), F('bSndOnRx', 0, 7, 0x40, 6), F('bHaltKBSnd', 0, 7, 0x80, 7),
    F('iBitStrmTO', 1, 1, 0xFF, 0, 4), F('iIDHoldTO', 1, 2, 0xFF, 0, 50), F('iIDLockOutTm', 1, 3, 0xFF, 0, 50),
    F('iUSBKeyPrsTm', 1, 4, 0xFF, 0, 4), F('iUSBKeyRlsTm', 1, 5, 0xFF, 0, 4),
    F('bUse64Bit', 1, 6, 0x02, 1), F('bPrxProEm', 1, 6, 0x08, 3), F('bSndSFID', 1, 6, 0x10, 4), F('bSndSFFC', 1, 6, 0x20, 5),
    F('bSndSFON', 1, 6, 0x40, 6), F('bUseNumKP', 1, 6, 0x80, 7),
    F('iRedLEDState', 2, 0, 0x01, 0), F('iGrnLEDState', 2, 0, 0x02, 1), F('iBeeperState', 2, 0, 0x04, 2), F('iRelayState', 2, 0, 0x08, 3),
    F('bUseLeadChrs', 2, 1, 0x01, 0), F('bAppCtrlsLED', 2, 1, 0x02, 1), F('bDspHex', 2, 1, 0x04, 2), F('bWiegInvData', 2, 1, 0x08, 3),
    F('bBeepID', 2, 1, 0x10, 4), F('bRevWiegBits', 2, 1, 0x20, 5), F('bRevBytes', 2, 1, 0x40, 6), F('bUseInvDataF', 2, 1, 0x80, 7),
    F('iCrdGnChr0', 2, 2, 0xFF), F('iCrdGnChr1', 2, 3, 0xFF),
    F('iLeadChrCnt', 2, 4, 0x0F), F('iTrailChrCnt', 2, 4, 0xF0, 4),
    F('iLeadChr0', 2, 5, 0xFF), F('iLeadChr1', 2, 6, 0xFF), F('iLeadChr2', 2, 7, 0xFF),
    // Page 3, from pcProxAPI.dll's page-3 packer: byte 7 = tsIDDispParms.iExOutputFormat
    // (0 = Data Format Mode, 1 = Extended Mode). Confirmed by the RDR-805x dump: vendor config 1 has 01 here.
    { ...F('iExOutputFormat', 3, 7, 0xFF), note: 'built-in (pcProxAPI.dll page-3 writer; confirmed by RDR-805x dump)' },
  ];
  // Not in the binary map: AZERTYShiftlock, ExtendedPrecisionMath, bNotBootDev, bLowerCaseHex
  // (location unknown), iTrailChr0..2 (share the iLeadChr bytes, offset by iLeadChrCnt).

  // Character fields (iFACIDDelim, iELDelim, lead/trail/gone chars) are USB HID keyboard
  // scancodes; bit 0x80 = Shift. e.g. 40 (0x28) = Enter, 179 (0xB3) = Shift+';' = ':'.
  const SC = { 0x28: 'Enter', 0x29: 'Esc', 0x2A: 'Backspace', 0x2B: 'Tab', 0x2C: 'Space', 0x2D: '-', 0x2E: '=', 0x2F: '[', 0x30: ']', 0x31: '\\', 0x33: ';', 0x34: "'", 0x35: '`', 0x36: ',', 0x37: '.', 0x38: '/' };
  const SHIFTED = { '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', '`': '~', ',': '<', '.': '>', '/': '?', 1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')' };
  PCX.CHAR_KEYS = ['iFACIDDelim', 'iELDelim', 'iCrdGnChr0', 'iCrdGnChr1', 'iLeadChr0', 'iLeadChr1', 'iLeadChr2', 'iTrailChr0', 'iTrailChr1', 'iTrailChr2'];
  PCX.scancodeName = v => {
    if (!v) return 'none';
    const shift = (v & 0x80) !== 0, c = v & 0x7F;
    let k = null;
    if (c >= 0x04 && c <= 0x1D) k = String.fromCharCode(97 + c - 4);
    else if (c >= 0x1E && c <= 0x27) k = String((c - 0x1D) % 10);
    else k = SC[c] || null;
    if (k == null) return `scancode 0x${c.toString(16).toUpperCase()}${shift ? ' + Shift' : ''}`;
    if (!shift) return k;
    if (k.length === 1 && /[a-z]/.test(k)) return k.toUpperCase();
    return SHIFTED[k] ?? `Shift+${k}`;
  };

  // Parse the vendor utility's "Save USB device hex raw data to (SDK) file" output.
  // Returns { readerType, configs: [{ index, pages: { 0x80: Uint8Array(8), ... } }] }
  PCX.parseRawDump = text => {
    const out = { readerType: null, configs: [] };
    let cur = null, lastTx = null;
    for (const raw of String(text).replace(/\r/g, '').split('\n')) {
      const line = raw.trim();
      let m;
      if ((m = line.match(/^#\s*Reader Type\s+(\S+)/i))) out.readerType = m[1];
      else if ((m = line.match(/^#\s*Configuration\s+(\d+)/i))) { cur = { index: Number(m[1]) - 1, pages: {} }; out.configs.push(cur); }
      else if ((m = line.match(/^Tx:\s*(.*)$/i))) lastTx = PCX.hexToBytes(m[1]);
      else if ((m = line.match(/^Rx:\s*(.*)$/i)) && lastTx) {
        if (!cur) { cur = { index: 0, pages: {} }; out.configs.push(cur); }
        const rx = PCX.hexToBytes(m[1]).slice(0, 8);
        if (lastTx[0] === 0x85 && lastTx[3] === 0x10) (cur.fldSep = cur.fldSep || {})[lastTx[1]] = rx; // portal extension
        else cur.pages[lastTx[0]] = rx;
        lastTx = null;
      }
    }
    if (!out.configs.length) throw new Error('No "Tx:/Rx:" feature reports found — is this a raw-data dump from the vendor utility?');
    return out;
  };

  // .hwg+ sFldSepData text -> bytes (all hex pairs in order; comment lines start with '/').
  PCX.fldSepBytes = text => {
    const hex = String(text || '').split('\n').filter(l => !/^\s*\//.test(l)).join(' ').match(/[0-9a-f]{2}/gi) || [];
    return Uint8Array.from(hex.map(h => parseInt(h, 16)));
  };

  // ---------- Card ID helpers ----------
  // Extract an ID from a raw report given a (runtime-confirmed) layout.
  PCX.extractCardId = (bytes, layout) => {
    const L = Object.assign({ bitCountByte: 0, idStart: 1, idLen: 8, reverse: false }, layout || {});
    // reverse = bytes are little-endian (least significant first); output idBytes are big-endian.
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
