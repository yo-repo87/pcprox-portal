# Fact check: protocol reference vs. vendor utility (app-64)

Compared on Nov 2, 2026 against the vendor's configuration utility in `app-64` (v6.17.0), cross-checked with the open-source *pcprox* library and protocol notes (M. Farrell, tested on 0C27:3BFA / RDR-6081AKU). Only facts and data layouts were used; no vendor code is copied into the portal.

## What the utility actually is

An Electron app. Its JavaScript (`pcprox-sdk.js`) only calls functions in `pcProxAPI.dll` (`usbConnect`, `GetActiveID`, `getCfgFlags_*` / `setCfgFlags_*`, `WriteCfg`, `SetActConfig`, `BeepNow`, …). The wire protocol lives inside the DLL.

## Corrections

| Reference doc said | Evidence | Verdict / portal change |
| --- | --- | --- |
| USB config uses 24-byte ASCII commands (`QRZ`, `SL0`, …) with `R..` acks | The DLL's raw-dump writer labels its output `# 8 byte USB Feature Reports`. The `QRZ`/`SL0`/`QSV` strings sit next to the *pcSwipe* and *Sonar* template code. The open-source library talks to 0C27:3BFA with 8-byte binary reports. | **Likely wrong for pcProx readers.** The portal now defaults to the 8-byte binary protocol. ASCII is kept as an option. |
| QRZ field map beyond bytes 0–4 unknown | Open-source notes give the full layout of config pages 0–2 (0x80/0x81/0x82), including bit positions. | Built-in map for 46 settings. Time fields are stored in 4 ms / 50 ms ticks. |
| Write layout unknown | Write = `[0x80|page]`, then the 8 page bytes, then `[0x90, mask]` to finish (mask = pages to save to EEPROM). | Implemented, with read-back verification and an EEPROM on/off option. |
| Card ID read via an ASCII poll | `0x8F` = ID buffer (little-endian, parity already stripped), `0x8E` byte 0 = bit count. The vendor UI also prints the buffer high byte first. | Card reads poll 0x8F/0x8E. The ID is decoded little-endian. |
| Beep digit is a "level" 1–5 / 1–2 | `BeepNow(count, longBeep)`: the digit is the **number of beeps**. Volume is a separate call (`SetBeeperVolume`: off/low/medium/high). | Relabelled. No 8-byte beep command is known, so beep is disabled in binary mode. |
| VID/PID table | `pcProxVIDPID.txt` also lists `171B:2001 NT-ware` and `0C27:CCDB Imprivata FIDO CCID`. 3BFA only appears inside the DLL ("0C27:3BFA RF IDeas"). | Added. 3BFA is labelled as the pcProx keyboard-emulation reader. |
| Delimiter values (179, 40) | They are USB keyboard scancodes (0x80 = Shift): 40 = Enter, 179 = `:`. | Format page shows the key name. |
| Factory reset / save defaults "no command" | The DLL has `ResetFactoryDflts`, `SaveUserDflts`, `pcProxPlusDefaults`. Their wire bytes are not visible from the JavaScript. | Still not implemented. A raw dump would reveal them. |
| Configuration slots | `GetMaxConfig` / `SetActConfig` / `GetActConfig` exist, so slots are selected per configuration. | Slot select command still unknown. Only slot 1 is written. |
| Card type codes | `cardDefaultSettings.json` maps codes to names (e.g. EF04 = HID Prox : RDR-608x Compatible, EF01 = HID Prox UID, 6F01 = RDR-758x Equivalent). | Slot dropdowns show names. |

## Confirmed

- The `.hwg+` key names, section order, comments, `##NEXTCONFIG##`, `CardType` and `CardPriority` lines, and `sFldSepData` blocks all match the DLL's writer strings.
- The 14 preset files in `docs/presets` are identical to `app-64/DataFiles`.
- `GetActiveID` returns up to 8 bytes (0–63 bits). `GetActiveID32` returns up to 32 bytes (255 bits).

## Still unverified on your reader (RDR-805x1AxU, fw 16.9.0)

The open-source layout was tested on an RDR-6081AKU (fw 07.3.0). The 805x is a multi-configuration pcProx Plus, so before writing, check that the values the portal reads match what the vendor utility shows. The fastest way to confirm everything, including slot selection, beep and save-defaults, is a raw dump from the vendor utility: **+ → Save USB device hex raw data to (SDK) file**. That file lists every Tx/Rx feature report per configuration.

## Browser limitation

0C27:3BFA presents itself as a USB keyboard. Chrome and Edge block WebHID access to keyboard interfaces. If the reader has no other (vendor-defined) interface, it will not appear in the browser's picker at all, whatever the protocol. This is a browser rule and can only be confirmed by trying.
