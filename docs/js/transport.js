/* WebHID transport + a simulated reader with the same interface.
 * Implements the reference's reliability rules: serialized access (lock),
 * 6x / 80 ms feature-write retry, 24-byte CR-terminated command reports. */
(function (root) {
  'use strict';
  const PCX = root.PCX = root.PCX || {};
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Promise-chain mutex: every device operation is serialized.
  class Lock {
    constructor() { this.tail = Promise.resolve(); }
    run(fn) {
      const next = this.tail.then(fn, fn);
      this.tail = next.catch(() => {});
      return next;
    }
  }

  // Sum the bit size of a HID report description.
  const reportBytes = rep => Math.ceil((rep.items || []).reduce((n, it) => n + (it.reportSize || 0) * (it.reportCount || 0), 0) / 8);

  class BaseReader {
    constructor() {
      this.lock = new Lock();
      this.listeners = { tx: [], rx: [], input: [], status: [] };
      this.lastActivity = 0;
      this.status = 0;
      this.reportId = 0;
      this.reportLen = PCX.REPORT_LEN;
      this.pollReads = 10;      // GET_FEATURE attempts while waiting for an ack
      this.pollDelay = 15;      // ms between those attempts
      this.continuationReads = 0; // extra reads for multi-report replies (Runtime-confirm)
    }
    on(ev, fn) { this.listeners[ev].push(fn); }
    emit(ev, ...a) { this.listeners[ev].forEach(f => { try { f(...a); } catch (e) { console.error(e); } }); }

    async writeFeature(bytes) {
      let lastErr;
      for (let i = 1; i <= PCX.WRITE_RETRIES; i++) {
        try {
          this.emit('tx', bytes, this.reportId);
          await this._send(bytes);
          this.status = 0x202;
          this.lastActivity = performance.now();
          return;
        } catch (e) {
          lastErr = e;
          if (i < PCX.WRITE_RETRIES) await sleep(PCX.WRITE_RETRY_MS);
        }
      }
      throw new Error(`SET_FEATURE failed after ${PCX.WRITE_RETRIES} attempts: ${lastErr && lastErr.message}`);
    }
    async readFeature() {
      const bytes = await this._receive();
      this.lastActivity = performance.now();
      this.emit('rx', bytes, this.reportId);
      return bytes;
    }

    /* Send one ASCII command and collect its reply.
     * Query commands wait for the Q->R ack; other commands return the first non-empty reply. */
    command(cmd, opts = {}) {
      return this.lock.run(async () => {
        const ack = PCX.ackFor(cmd);
        await this.writeFeature(PCX.encodeCommand(cmd, this.reportLen));
        const polls = opts.pollReads ?? this.pollReads;
        let reply = null, raw = null;
        for (let i = 0; i < polls; i++) {
          if (i) await sleep(this.pollDelay);
          raw = await this.readFeature();
          const d = PCX.decodeReply(raw);
          if (!d.text) continue;
          if (ack && !d.text.toUpperCase().startsWith(ack)) continue;
          reply = d; break;
        }
        if (!reply) {
          const last = raw ? PCX.decodeReply(raw).text : '';
          if (ack) throw new Error(`No "${ack}" ack for ${cmd} after ${polls} reads${last ? ` (last reply "${last}")` : ''}`);
          return { text: last, raws: raw ? [raw] : [] };
        }
        const raws = [raw];
        let text = reply.text;
        // Optional continuation for replies longer than one report (Runtime-confirm).
        const cont = opts.continuationReads ?? this.continuationReads;
        let prevFull = !reply.terminated;
        for (let i = 0; i < cont && prevFull; i++) {
          await sleep(this.pollDelay);
          const r = await this.readFeature();
          const d = PCX.decodeReply(r);
          if (!d.text) break;
          raws.push(r);
          text += ack && d.text.toUpperCase().startsWith(ack) ? d.text.slice(3) : d.text;
          prevFull = !d.terminated;
        }
        return { text, raws };
      });
    }

    rawExchange(bytes, read = true) {
      return this.lock.run(async () => {
        const buf = new Uint8Array(this.reportLen);
        buf.set(bytes.slice(0, this.reportLen));
        await this.writeFeature(buf);
        if (!read) return null;
        await sleep(this.pollDelay);
        return this.readFeature();
      });
    }
    rawRead() { return this.lock.run(() => this.readFeature()); }
  }

  // ---------- Real device via WebHID ----------
  class HidReader extends BaseReader {
    constructor(device) {
      super();
      this.device = device;
      this.kind = 'hid';
      this._onInput = e => {
        const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength).slice();
        this.lastActivity = performance.now();
        this.emit('input', bytes, e.reportId);
      };
    }
    static supported() { return typeof navigator !== 'undefined' && !!navigator.hid; }
    static async request(extraVids = []) {
      const filters = [...PCX.VENDOR_IDS, ...extraVids].map(vendorId => ({ vendorId }));
      const devs = await navigator.hid.requestDevice({ filters });
      return devs;
    }
    static async granted() {
      const devs = await navigator.hid.getDevices();
      return devs.filter(d => PCX.VENDOR_IDS.includes(d.vendorId));
    }
    get vid() { return this.device.vendorId; }
    get pid() { return this.device.productId; }
    get name() { return this.device.productName || 'HID device'; }
    get vidpid() { return PCX.vidpid(this.vid, this.pid); }

    describe() {
      const cols = this.device.collections || [];
      return cols.map(c => ({
        usagePage: c.usagePage, usage: c.usage,
        feature: (c.featureReports || []).map(r => ({ id: r.reportId, bytes: reportBytes(r) })),
        input: (c.inputReports || []).map(r => ({ id: r.reportId, bytes: reportBytes(r) })),
        output: (c.outputReports || []).map(r => ({ id: r.reportId, bytes: reportBytes(r) })),
      }));
    }
    // Pick report id/size from the descriptor; the reference says the id is 0 or 1.
    detectReport() {
      const feats = this.describe().flatMap(c => c.feature);
      const pick = feats.find(f => f.id === 1) || feats.find(f => f.id === 0) || feats[0];
      if (pick) { this.reportId = pick.id; if (pick.bytes > 0) this.reportLen = Math.min(pick.bytes, PCX.MAX_WIRE_LEN - 1) || PCX.REPORT_LEN; }
      return { reportId: this.reportId, reportLen: this.reportLen, found: !!pick };
    }
    hasVendorCollection() { return this.describe().some(c => c.usagePage >= 0xFF00); }

    async open() {
      if (!this.device.opened) await this.device.open();
      this.device.addEventListener('inputreport', this._onInput);
      return this.detectReport();
    }
    async close() {
      this.device.removeEventListener('inputreport', this._onInput);
      if (this.device.opened) await this.device.close();
    }
    async forget() { if (this.device.forget) await this.device.forget(); }
    async _send(bytes) { await this.device.sendFeatureReport(this.reportId, bytes); }
    async _receive() {
      const dv = await this.device.receiveFeatureReport(this.reportId);
      let b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice();
      // Chromium includes the report-id byte in the returned data when the id is non-zero.
      if (this.reportId !== 0 && b[0] === this.reportId) b = b.slice(1);
      return b;
    }
  }

  // ---------- Simulated reader (for trying the portal without hardware) ----------
  // Simulator semantics (block contents, SL0 meaning, card report layout) are illustrative only.
  class SimReader extends BaseReader {
    constructor() {
      super();
      this.kind = 'sim';
      this.vid = 0x0C27; this.pid = 0x3BFB;
      this.name = 'Simulated pcProx';
      this.vidpid = PCX.vidpid(this.vid, this.pid);
      this.block = Uint8Array.from([0x05, 0x03, 0x00, 0x1A, 0x10, 0x01, 0x01, 0xB3, 0x28, 0x14]);
      this.pending = new Uint8Array(this.reportLen);
    }
    describe() { return [{ usagePage: 0xFF00, usage: 0x01, feature: [{ id: 0, bytes: 24 }], input: [{ id: 0, bytes: 9 }], output: [] }]; }
    detectReport() { return { reportId: 0, reportLen: 24, found: true }; }
    hasVendorCollection() { return true; }
    async open() { return this.detectReport(); }
    async close() {}
    async forget() {}
    _reply(s) { const o = new Uint8Array(this.reportLen); const t = s + '\r'; for (let i = 0; i < t.length && i < o.length; i++) o[i] = t.charCodeAt(i); return o; }
    async _send(bytes) {
      await sleep(4);
      const cmd = PCX.decodeReply(bytes).text.toUpperCase();
      const hexStr = s => PCX.toHex(Array.from(s, c => c.charCodeAt(0)), '');
      let r = '';
      if (cmd === 'QRZ') r = 'RRZ' + PCX.toHex(this.block, '');
      else if (cmd === 'QSV') r = 'RSV' + hexStr('SIM1430');
      else if (cmd === 'QDD') r = 'RDD' + '0C273BFB0001';
      else if (cmd === 'QUP') r = 'RUP' + PCX.hex2(Math.floor(performance.now() / 1000) >> 8) + PCX.hex2(Math.floor(performance.now() / 1000));
      else if (cmd === 'QS0') r = 'RS0' + '00000000';
      else if (/^G[SL]0$/.test(cmd)) r = cmd.replace(/^G/, 'R') + '00';
      else if (/^SL0[0-9A-F]{4}$/.test(cmd)) {
        const a = parseInt(cmd.substr(3, 2), 16), v = parseInt(cmd.substr(5, 2), 16);
        if (a < this.block.length) { this.block[a] = v; r = 'OK'; } else r = 'ERR';
      }
      else if (/^B[SL][1-5]$/.test(cmd)) { this._beep(cmd[1] === 'L'); r = 'OK'; }
      else if (bytes[0] === 0x89) r = 'R89' + '00'.repeat(8);
      else r = 'ERR';
      this.pending = this._reply(r);
    }
    async _receive() { await sleep(3); return this.pending.slice(); }
    _beep(long) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator(); o.frequency.value = 2700; o.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + (long ? 0.45 : 0.12));
        o.onended = () => ctx.close();
      } catch (_) {}
    }
    // Simulated tap: H10301-style 26-bit card. Report = [bitCount, id bytes (8, big-endian)].
    tap(fac = 123, id = 45678) {
      const data = ((fac & 0xFF) << 16) | (id & 0xFFFF);
      const ones = n => n.toString(2).split('').filter(c => c === '1').length;
      const ep = ones((data >> 12) & 0xFFF) % 2;           // even parity over first 12 data bits
      const op = 1 - (ones(data & 0xFFF) % 2);             // odd parity over last 12 data bits
      const v = (ep << 25) | (data << 1) | op;
      const rep = new Uint8Array(9);
      rep[0] = 26;
      for (let i = 0; i < 4; i++) rep[8 - i] = (v >>> (8 * i)) & 0xFF;
      this.lastActivity = performance.now();
      this.emit('input', rep, 0);
    }
  }

  PCX.HidReader = HidReader;
  PCX.SimReader = SimReader;
  PCX.sleep = sleep;
})(typeof window !== 'undefined' ? window : globalThis);
