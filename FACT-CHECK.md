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
| Beep digit is a "level" 1–5 / 1–2 | `BeepNow(count, longBeep)`: the digit is the **number of beeps**. Volume is a separate call (`SetBeeperVolume`: off/low/medium/high). | Relabelled. The 8-byte beep is `8C 03 nn` (see below). |
| VID/PID table | `pcProxVIDPID.txt` also lists `171B:2001 NT-ware` and `0C27:CCDB Imprivata FIDO CCID`. 3BFA only appears inside the DLL ("0C27:3BFA RF IDeas"). | Added. 3BFA is labelled as the pcProx keyboard-emulation reader. |
| Delimiter values (179, 40) | They are USB keyboard scancodes (0x80 = Shift): 40 = Enter, 179 = `:`. | Format page shows the key name. |
| Factory reset / save defaults "no command" | The DLL has `ResetFactoryDflts`, `SaveUserDflts`, `pcProxPlusDefaults`. Their wire bytes are not visible from the JavaScript. | Recovered: `89 82 src dst 00 FF` memory-bank copies (see below). Now in the portal on Home. |
| Configuration slots | `GetMaxConfig` / `SetActConfig` / `GetActConfig` exist, so slots are selected per configuration. | Recovered: `89 81 n` selects a configuration, and page `84` holds the card type and priority. All slots are now read and written. |
| Card type codes | `cardDefaultSettings.json` maps codes to names (e.g. EF04 = HID Prox : RDR-608x Compatible, EF01 = HID Prox UID, 6F01 = RDR-758x Equivalent). | Slot dropdowns show names. |

## Confirmed

- The `.hwg+` key names, section order, comments, `##NEXTCONFIG##`, `CardType` and `CardPriority` lines, and `sFldSepData` blocks all match the DLL's writer strings.
- The 14 preset files in `docs/presets` are identical to `app-64/DataFiles`.
- `GetActiveID` returns up to 8 bytes (0–63 bits). `GetActiveID32` returns up to 32 bytes (255 bits).

## Still unverified on your reader (RDR-805x1AxU, fw 16.9.0)

The open-source layout was tested on an RDR-6081AKU (fw 07.3.0). The 805x is a multi-configuration pcProx Plus, so before writing, check that the values the portal reads match what the vendor utility shows. The fastest way to confirm everything, including slot selection, beep and save-defaults, is a raw dump from the vendor utility: **+ → Save USB device hex raw data to (SDK) file**. That file lists every Tx/Rx feature report per configuration.

## Smartcard Manager cross-check (your reader)

Your reader as shown by `SmartcardManager.exe`: protocol Keystroke/SDK, FW 16.9, LUID 0000, high-priority card 1. Its four configurations are:

1. HID Prox UID (EF01)
2. Keri UID : RDR-6K8x Compatible (F802)
3. CASI-RUSCO (GE Security, UTC) : RDR-628x Compatible (FC02)
4. Keri PSC-1 26 Bit (EA02)

- **Card types:** all four names are in the portal's card-type table, so the slot dropdowns can show the same setup.
- **Firmware:** "16.9" matches the major.release.minor format that the 8-byte device-info reply (0x8A) decodes to.
- **Not a source:** `SmartcardManager.exe` and `ConfigCardManager.exe` are compiled AutoIt scripts. Their protocol calls are not readable without decompiling, which I did not do.

## Commands recovered from pcProxAPI.dll (disassembly)

`SmartcardManager.exe` and `ConfigCardManager.exe` are compiled AutoIt scripts that hand off to `pcProxAPI.dll`, so I disassembled the DLL's USB code paths. I did not decrypt the AutoIt scripts. Data bytes are shown without the report-id byte. Every report is 8 bytes and is followed by a GET_FEATURE read.

| Function in the DLL | Feature report(s) | Notes |
| --- | --- | --- |
| Detect multi-config (USBConnect) | `89 01` → reply `89 ?? active count` | Reply byte 0 = 0x89 means a pcProx Plus. Count is 1–11. |
| Select configuration (SetActConfig, WriteCfg, DumpRawFeatureReports) | `89 81 n` (n = 0-based) → reply echoes `89 81` | Every config-specific read and write happens after this. |
| Card type + priority (GetCardType, SetCardTypePriority) | read `84`. Write `84`, then `00 lo hi prio` | Card type is little-endian (EF01 → `01 EF`). Priority bit is 0/1. |
| Config pages (ReadCfg / WriteCfg) | `80`/`81`/`82`/`83`/`85` select, then GET or SET 8 data bytes. Finish with `90 mask` | Mask bits: 01 p0, 02 p1, 04 p2, 08 p3, 20 p5, 80 LUID. The DLL packing matches the built-in page 0–2 map, including the 4 ms / 50 ms scaling. |
| BeepNow(count, long) | `8C 03 nn` | Short count 1–5. Long count 1–2 with 0x80 set. |
| Get / set beeper volume | `8C 06` → reply byte 2. Set: `8C 86 lvl` | 0 off, 1 low, 2 medium, 3 high. |
| SaveUserDflts | `89 82 01 02 00 FF` | Copies the working bank to the stored bank, then waits 100 ms. |
| ResetFactoryDflts (Plus: "reset to stored settings") | `89 82 02 01 00 FF` | Copies stored → working. |
| pcProxPlusDefaults (factory) | `89 82 03 02 00 FF`, then `89 82 03 01 00 FF` | Copies factory → stored and factory → working. |
| DumpRawFeatureReports | for each config: select, then query `80 81 82 83 84 85 87 88 89 8A 8B 8C 8D 8E 8F` | This is what "Save USB device hex raw data" writes. |

All of these are now in the portal:

- **Multi-config reads:** all configurations are read on a pcProx Plus.
- **Writes per configuration:** each configuration is written separately, including card type and the High Priority Card setting.
- **Reader controls:** beep, volume, save user defaults, restore user defaults, and factory reset.
- **Simulator:** it now behaves like a 4-config RDR-805x.

Still untested on real hardware: these come from the DLL's code paths, not from a capture of your reader.

## Browser limitation

0C27:3BFA presents itself as a USB keyboard. Chrome and Edge block WebHID access to keyboard interfaces. If the reader has no other (vendor-defined) interface, it will not appear in the browser's picker at all, whatever the protocol. This is a browser rule and can only be confirmed by trying.
