/* .hwg / .hwg+ configuration file parsing and export.
 * .hwg+ is the keyed template format ("key = value / comment"), possibly with several
 * configurations separated by ##NEXTCONFIG##. .hwg is the older positional format. */
(function (root) {
  'use strict';
  const PCX = root.PCX = root.PCX || {};

  // Setting catalog, in .hwg+ section order, with the descriptions the template files carry.
  const S = (section, key, desc) => ({ section, key, desc, type: key[0] === 'b' || /^(AZERTY|Extended)/.test(key) ? 'bool' : 'int' });
  PCX.SETTINGS = [
    S('AZERTYShiftLock', 'AZERTYShiftlock', '0 = off, 1 = on'),
    S('ExtendedPrecisionMath', 'ExtendedPrecisionMath', '0 = off, 1 = on'),
    S('tsIDBitCnts', 'iLeadParityBitCnt', 'Wiegand leading parity bit count to be stripped'),
    S('tsIDBitCnts', 'iTrailParityBitCnt', 'Wiegand trailing parity bit count to be stripped'),
    S('tsIDBitCnts', 'iIDBitCnt', 'If bStripFac, this determines bit count of ID and FAC'),
    S('tsIDBitCnts', 'iTotalBitCnt', 'If bFrcBitCntEx, card read (including parity) must match this'),
    S('tsCfgFlags', 'bFixLenDsp', 'Send as fixed length with leading zeros as needed'),
    S('tsCfgFlags', 'bFrcBitCntEx', "Force Rx'd bit count to be exact to be valid"),
    S('tsCfgFlags', 'bStripFac', 'Strip the FAC from the ID (not discarded)'),
    S('tsCfgFlags', 'bSndFac', 'Send the FAC (if stripped from data)'),
    S('tsCfgFlags', 'bUseDelFac2Id', 'Put a delimiter between FAC and ID on send'),
    S('tsCfgFlags', 'bNoUseELChar', "Don't use an EndLine char on send (default ENTER)"),
    S('tsCfgFlags', 'bSndOnRx', 'Send valid ID as soon as it is received (iIDLockOutTm not used)'),
    S('tsCfgFlags', 'bHaltKBSnd', "Don't send keys to USB (Get ID mechanism)"),
    S('tsIDDispParms', 'iFACIDDelim', 'If bStripFac & bSndFac & bUseDelFac2Id, char sent between FAC & ID'),
    S('tsIDDispParms', 'iELDelim', 'If NOT bNoUseELChar, char sent at end of ID'),
    S('tsIDDispParms', 'iIDDispLen', 'If bFixLenDsp, ID padded with zeros to this length'),
    S('tsIDDispParms', 'iFACDispLen', 'If bFixLenDsp, FAC padded with zeros to this length'),
    S('tsIDDispParms', 'iExOutputFormat', '0 = Data Format Mode, 1 = Extended Mode'),
    S('tsTimeParms', 'iBitStrmTO', 'Wiegand read timeout, ms (4 ms gran.)'),
    S('tsTimeParms', 'iIDHoldTO', 'Card ID remains valid for this time, ms (50 ms gran.)'),
    S('tsTimeParms', 'iIDLockOutTm', 'Squelch repetitive reports, ms (50 ms gran.)'),
    S('tsTimeParms', 'iUSBKeyPrsTm', "USB inter-key 'press' time, ms (4 ms gran.)"),
    S('tsTimeParms', 'iUSBKeyRlsTm', "USB inter-key 'release' time, ms (4 ms gran.)"),
    S('tsCfgFlags2', 'bUseLeadChrs', 'Use leading chars in ID KB send'),
    S('tsCfgFlags2', 'bDspHex', 'Display ID as ASCII hex [not ASCII decimal]'),
    S('tsCfgFlags2', 'bWiegInvData', 'Wiegand data on pins is inverted'),
    S('tsCfgFlags2', 'bUseInvDataF', 'Use the bWiegInvData flag over hardware setting'),
    S('tsCfgFlags2', 'bRevWiegBits', 'Reverse the Wiegand Rx bits'),
    S('tsCfgFlags2', 'bBeepID', 'Beep when ID received'),
    S('tsCfgFlags2', 'bRevBytes', 'Reverse byte order (CSN reader)'),
    S('tsCfgFlags3', 'bUseNumKP', 'Euro KB flag'),
    S('tsCfgFlags3', 'bSndSFON', 'Split format ON = 1, old combined scheme = 0'),
    S('tsCfgFlags3', 'bSndSFFC', '0 = FAC decimal, 1 = FAC hex'),
    S('tsCfgFlags3', 'bSndSFID', '0 = ID decimal, 1 = ID hex'),
    S('tsCfgFlags3', 'bPrxProEm', 'Use ProxPro emulation'),
    S('tsCfgFlags3', 'bUse64Bit', '0 = 32-bit, 1 = 64-bit display math'),
    S('tsCfgFlags3', 'bNotBootDev', 'USB enum: 0 = BootDevice, 1 = NOTBootDevice'),
    S('tsCfgFlags3', 'bLowerCaseHex', '0 = upper case, 1 = lower case'),
    S('tsIDDispParms2', 'iLeadChrCnt', 'If bUseLeadChrs, lead char count (<=3)'),
    S('tsIDDispParms2', 'iLeadChr0', 'Lead character 0'),
    S('tsIDDispParms2', 'iLeadChr1', 'Lead character 1'),
    S('tsIDDispParms2', 'iLeadChr2', 'Lead character 2'),
    S('tsIDDispParms2', 'iCrdGnChr0', 'If non-zero, sent when ID goes invalid'),
    S('tsIDDispParms2', 'iCrdGnChr1', 'If this and Chr0 non-zero, sent when ID goes invalid'),
    S('tsIDDispParms3', 'iTrailChrCnt', 'Trail char count (<=3)'),
    S('tsIDDispParms3', 'iTrailChr0', 'Trail character 0'),
    S('tsIDDispParms3', 'iTrailChr1', 'Trail character 1 (LeadChrCnt + TrailChrCnt <= 3)'),
    S('tsIDDispParms3', 'iTrailChr2', 'Trail character 2 (lead chars have priority)'),
    S('tsLEDCtrl', 'bAppCtrlsLED', 'Display LEDs are controlled by the host'),
    S('tsLEDCtrl', 'iRedLEDState', '0 = off, 1 = on'),
    S('tsLEDCtrl', 'iGrnLEDState', '0 = off, 1 = on'),
    S('tsBprRlyCtrl', 'iBeeperState', '0 = off, 1 = on'),
    S('tsBprRlyCtrl', 'iRelayState', '0 = off, 1 = on'),
  ];
  PCX.SETTING_KEYS = PCX.SETTINGS.map(s => s.key);
  PCX.settingInfo = k => PCX.SETTINGS.find(s => s.key === k);

  // Positional map for legacy .hwg (BEST-GUESS: inferred by lining legacy files up against
  // the keyed template; positions not listed are kept as legacy_N). Confirm before relying on it.
  PCX.LEGACY_HWG_MAP = [
    'iFACIDDelim', 'iELDelim', 'iIDDispLen', 'iFACDispLen',
    'iLeadParityBitCnt', 'iTrailParityBitCnt', 'iIDBitCnt', 'iTotalBitCnt',
    'bFixLenDsp', 'bFrcBitCntEx', 'bStripFac', 'bSndFac', 'bUseDelFac2Id', 'bNoUseELChar', 'bSndOnRx', 'bHaltKBSnd',
    'iBitStrmTO', 'iIDHoldTO', 'iIDLockOutTm',
  ];

  function parseHwgPlus(text) {
    const chunks = String(text).replace(/\r/g, '').split(/^##NEXTCONFIG##\s*$/m);
    const header = {};
    const configs = [];
    for (const chunk of chunks) {
      const cfg = { settings: {}, unknown: {}, fldSepData: null, cardType: null, cardPriority: null };
      let inFld = false, fld = [];
      for (const line0 of chunk.split('\n')) {
        const line = line0.trim();
        if (!line) { if (inFld) fld.push(''); continue; }
        if (/^BEGIN\s+sFldSepData/.test(line)) { inFld = true; fld = []; continue; }
        if (/^END\s+sFldSepData/.test(line)) { inFld = false; cfg.fldSepData = fld.join('\n').trim(); continue; }
        if (inFld) { fld.push(line0.replace(/\s+$/, '')); continue; }
        let m;
        if ((m = line.match(/^:Library Version:\s*(.*)$/))) { header.libVersion = m[1].trim(); continue; }
        if ((m = line.match(/^:Device FW Version:\s*(.*)$/))) { header.fwVersion = m[1].trim(); continue; }
        if ((m = line.match(/^CardType:\s*(-?\d+)/))) { cfg.cardType = Number(m[1]); continue; }
        if ((m = line.match(/^CardPriority:\s*(-?\d+)/))) { cfg.cardPriority = Number(m[1]); continue; }
        if (line[0] === '/') continue;
        if ((m = line.match(/^([A-Za-z_][\w]*)\s*=\s*(-?\w+)/))) {
          const v = /^-?\d+$/.test(m[2]) ? Number(m[2]) : (/^0x[0-9a-f]+$/i.test(m[2]) ? parseInt(m[2], 16) : m[2]);
          if (PCX.SETTING_KEYS.includes(m[1])) cfg.settings[m[1]] = v; else cfg.unknown[m[1]] = v;
        }
      }
      if (Object.keys(cfg.settings).length || cfg.fldSepData || cfg.cardType != null) configs.push(cfg);
    }
    return { format: 'hwg+', header, configs };
  }

  function parseHwgLegacy(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const cfg = { settings: {}, unknown: {}, fldSepData: null, cardType: null, cardPriority: null, legacy: true };
    lines.forEach((l, i) => {
      const t = l.trim().replace(/^"(.*)"$/, '$1');
      const v = /^-?\d+$/.test(t) ? Number(t) : t;
      const key = PCX.LEGACY_HWG_MAP[i];
      if (key) cfg.settings[key] = v; else cfg.unknown['legacy_' + i] = v;
    });
    return { format: 'hwg', header: {}, configs: [cfg] };
  }

  PCX.parseHwg = text => {
    const t = String(text);
    return /^\s*\/---|^\s*\w+\s*=\s*/m.test(t) ? parseHwgPlus(t) : parseHwgLegacy(t);
  };

  PCX.serializeHwgPlus = (configs, header = {}) => {
    const out = ['/--- pcProx and OEM Reader Configuration Template File ---',
      `:Library Version: ${header.libVersion || 'webhid-portal'} `,
      `:Device FW Version: ${header.fwVersion || 'unknown'} `, ''];
    configs.forEach((cfg, ci) => {
      let section = null;
      for (const s of PCX.SETTINGS) {
        if (!(s.key in cfg.settings)) continue;
        if (s.section !== section) { if (section) out.push(''); out.push('/ ' + s.section); section = s.section; }
        out.push(`${s.key} = ${cfg.settings[s.key]}     / ${s.desc}`);
      }
      if (cfg.fldSepData) out.push('', 'BEGIN sFldSepData', '', cfg.fldSepData, '', 'END sFldSepData');
      if (cfg.cardType != null) out.push(`CardType: ${cfg.cardType} / Card type code`);
      if (cfg.cardPriority != null) out.push(`CardPriority: ${cfg.cardPriority} / 0=Low, 1=High Priority`);
      if (configs.length > 1 || cfg.cardType != null) out.push('##NEXTCONFIG##');
      if (ci < configs.length - 1) out.push('');
    });
    return out.join('\r\n') + '\r\n';
  };
})(typeof window !== 'undefined' ? window : globalThis);
