# pcProx WebHID Portal

A browser-only version of the reader portal. It talks to rf IDeas readers directly over **WebHID**. You don't need `start-helper.bat`, a local service, or an install. It is built from *rf IDeas pcProx — USB HID & Configuration Protocol Reference.md*.

> **Update (Nov 2, 2026):** after checking against the vendor utility, the portal defaults to the pcProx **8-byte binary** feature-report protocol with a built-in settings map. The 24-byte ASCII protocol from the reference doc is still selectable on Home. See `../FACT-CHECK.md`. The status table below describes the ASCII mode.

## Running it

- **Hosted:** https://yo-repo87.github.io/pcprox-portal/ (GitHub Pages, served from `docs/`).
- **Local:** serve the `docs` folder over localhost, for example `npx serve docs` or `python -m http.server -d docs`, then open `http://localhost:<port>/`.
- **From disk:** opening `index.html` directly also works in Chrome/Edge. Presets then come from `js/presets-bundle.js`.

You need Chrome or Edge on desktop. WebHID only lists readers that expose a vendor-defined HID interface, so a reader in pure keyboard-wedge mode must first be switched to a vendor / HID-CDC mode.

## What it does

| Area | Status in the reference | Behaviour |
| --- | --- | --- |
| Device discovery (VID 0x0C27 / 0x19E5), model lookup | Confirmed | Picker and auto-reconnect to granted readers |
| 24-byte CR-terminated ASCII commands, Q→R ack, hex payloads | Confirmed | All commands; 6× / 80 ms write retry; serialized access |
| Beep `BS1–5` / `BL1–2` | Confirmed | Buttons |
| Read `QRZ` / `QSV` / `QDD` / `QS0` / `QUP` / `GS0` / `GL0` | Confirmed | Settings tab, workbench, console |
| QRZ bytes 0–4 decode | Confirmed | Shown under the QRZ block |
| QRZ bytes 5…n, write byte layout | **Runtime-confirm** | Built per model in the **Mapping workbench** (capture → diff → assign) |
| Card reads, 235 ms throttle, ID hold | Confirmed | Input reports plus an optional poll command |
| Card ID byte layout | **Runtime-confirm** | Set in the workbench |
| Secure-data frame 0x89 | Frame confirmed, response not | Raw send/receive |

## Safety model

These readers control physical access, so writing stays locked until you have confirmed the layout yourself:

1. A setting can only be written once a byte/mask for it has been **mapped**. The map is built from your own before/after diffs.
2. You have to enter a **write template** (for example `SL0{ADDR}{VAL}` or `FR{OFFSET}{DATA}`) and tick that you validated it on a reader you can safely re-flash. Changing the template clears that tick.
3. **Plan write** shows the exact byte changes and commands before anything is sent.
4. After a write, the reader is re-read and every changed byte is checked.

Field maps are saved per VID:PID in the browser. Export them as JSON to share across PCs.

## Not ported from the helper portal

- **Save user defaults** and **Reset to factory defaults**: the protocol reference gives no command for either.
- **Writing `sFldSepData`** (field-separator blocks in `.hwg+` files): it is parsed and shown, but no confirmed command writes it.
- **Legacy positional `.hwg` files**: these are read with a best-guess mapping of the first 19 positions. The rest are shown raw.

## Files

```
docs/
  index.html, style.css
  js/protocol.js        framing, command table, decoders (no I/O)
  js/transport.js       WebHID reader + simulated reader
  js/hwg.js             .hwg / .hwg+ parse and export
  js/fieldmap.js        field map, diff, write planning
  js/app.js             UI
  js/presets-bundle.js  generated copy of presets for offline use
```

If you add presets to `docs/presets`, regenerate `presets-bundle.js`. It is only needed for opening the page from disk; hosted or local-server use reads `presets` directly.
