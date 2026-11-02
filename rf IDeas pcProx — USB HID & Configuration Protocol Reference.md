# rf IDeas pcProx — USB HID & Configuration Protocol Reference

Nov 2, 2026 · @Matthew Gibson

## Overview

This reference describes how to drive rf IDeas pcProx / pcSwipe readers at the protocol level: device discovery, the HID feature-report transport, the ASCII configuration protocol (read and write), the beeper, card reading, and the secure-data channel. It is written to be sufficient to program a reader from a WebHID or native host.

Readers are reached over one of three transports, selected when you connect: USB (HID feature reports), serial (RS-232), and network (TCP/IP). This document focuses on the USB path, which is what WebHID uses, and notes where serial and network differ.

Each item carries a status so you know what to rely on directly versus what to confirm against your specific model at runtime:

- Confirmed — the behaviour and exact bytes are established.
- Runtime-confirm — the mechanism is established, but a model-specific detail (a byte offset, a payload order) should be verified on the device before you depend on it, particularly for writes.

The last two sections give a single status table covering every element and an end-to-end checklist for bringing a reader up.

## Device identity & discovery

Readers enumerate under two USB vendor IDs. Filter on the vendor ID; the product ID identifies the model family.

| VID:PID | Model family |
| --- | --- |
| 0C27:3B4C | RF IDeas HID CDC |
| 0C27:3B1E | RF IDeas BLE |
| 0C27:3B57 | RF IDeas Wiegand |
| 0C27:3BFB | RF IDeas ProxAdv |
| 0C27:3BFA | RF IDeas (ProxAdv variant) |
| 0C27:CCDA | RF IDeas CCID |
| 0C27:3A01 | RF IDeas KPIT |
| 19E5:2021 | RF IDeas JM3 |

Vendor ID 0x0C27 is rf IDeas; 0x19E5 is used by the JM3. Device paths are `\\?\HID#Vid_%04x&Pid_%04x` for USB and `\\.\COM%d` for serial. A runtime VID/PID allow-list can be supplied via `pcProxVIDPID.txt`.

WebHID visibility caveat: WebHID refuses devices whose top-level HID usage looks like a keyboard or pointer. A reader running in keyboard-wedge mode presents as a keyboard and will not appear in the device picker. Switch the reader to a vendor-defined / HID-CDC mode so it exposes a vendor usage page, after which it is selectable. This is a browser security rule, not a reader limitation.

WebHID also requires a secure context (https or localhost) and a user gesture to open the picker.

## Transport architecture

State is kept in a device table (up to 127 slots, each 0x1de0 bytes) plus a few globals; every operation takes a shared lock, looks up the active device, and dispatches on a per-device transport field.

| Element | Location | Meaning |
| --- | --- | --- |
| Active device index | global | currently selected device (16-bit) |
| Device count | global | number of connected devices |
| Device table base | global | array, stride 0x1de0 per device |
| Backend select | device +0xc | selects the I/O backend (values 1, 2, 4) |
| Sub-transport flag | device +0x8 | within a backend, selects HID feature report vs an alternate sender |
| Global alt-backend flag | global | set when the alternate (libusb-style) USB driver is in use |
| HID handle | device +0x10 | handle passed to HidD\_Get/SetFeature |
| Alt handle | device +0x1550 | handle for the alternate sender |

Honest note on the numeric mapping: the `+0xc` field takes values 1, 2, and 4, and the dispatch in `GetActiveID`, `BeepNow`, `ReadCfg`, and `WriteCfg` all branch on it. Static analysis does not give a clean 1=serial / 2=USB / 4=network reading: the value-1 backend is set together with the global alt-USB flag, the value-2 backend drives the ASCII command transport over USB, and the value-4 backend calls the HID feature wrappers directly. In other words, more than one `+0xc` value resolves to USB HID through different sub-paths, while serial is entered via `ComConnect` and network via the Winsock path. Treat the exact numeric labels as something to confirm at runtime for your model; do not hard-code a setting on the assumption that a particular number means a particular wire.

What is certain: there are three physical transports (USB, serial, network); on USB the data ultimately moves as HID feature reports; and the secure-data channel is gated to the `+0xc == 1` backend (see that section).

## HID feature-report layer

On USB, all configuration and control moves through HID feature reports. The HID entry points are resolved at runtime (LoadLibrary of HID.DLL, then GetProcAddress for HidD\_GetFeature, HidD\_SetFeature, HidD\_GetAttributes, HidP\_GetCaps, HidD\_GetPreparsedData, HidD\_SetNumInputBuffers, HidD\_FlushQueue). On a Control-Flow-Guard build the indirect calls run through a guard dispatcher, which is transparent to behaviour.

Key rules of the layer:

- The on-wire report, including the leading report-id byte, is capped at 25 bytes.
- Byte 0 of the report is the report id. In WebHID this is passed as a separate argument and the data array holds bytes 1..n. The report id is 0 or 1 depending on a device flag.
- Writes retry up to 6 times, sleeping 80 ms between failures. A successful write sets the device status field to 0x202.
- Each read/write stamps the device's last-activity tick (used by the card-read throttle).

SET\_FEATURE (write) builds the report, sets byte 0, and calls HidD\_SetFeature(handle, buf, len) on the handle at device +0x10. GET\_FEATURE (read) calls HidD\_GetFeature(handle, buf, len) into a response buffer. An alternate sub-path (selected by device +0x8) routes the same bytes through a different sender using the handle at device +0x1550; the byte-level framing is identical.

In WebHID terms: `device.sendFeatureReport(reportId, bytes)` and `device.receiveFeatureReport(reportId)` are the two primitives everything else is built on.

## Configuration protocol (ASCII commands)

Configuration, version, and the beeper all use one ASCII command protocol carried over the feature-report layer. This is separate from the binary secure frame.

Framing, per command:

1. Take the command string and append a carriage return, `0x0D`.
2. Place it in a 24-byte feature report (zero-padded) and send with SET\_FEATURE.
3. Read the reply with GET\_FEATURE.
4. For query commands, the reader acknowledges by echoing the command with its first letter changed from `Q` to `R` (`QRZ` is acked by `RRZ`, `QSV` by `RSV`). Payloads are ASCII hex, two characters per byte.

Complete command set recovered from the command table:

| Command | Purpose | Direction |
| --- | --- | --- |
| `QRZ` | read main configuration block | read |
| `QSV` | read service / version block | read |
| `QDD` | read device-data block | read |
| `QS0` | read S0 page | read |
| `QUP` | read uptime / status | read |
| `GS0` | get S0 | read |
| `GL0` | get L0 | read |
| `SL0` | set L0; followed by two hex bytes (`SL0%02X%02X`) | write |
| `CD0` | clear / command D0 | write |
| `FR` | feature-report write (the WriteCfg USB entry) | write |
| `BS` | short beep; followed by a level digit (`BS1`..`BS5`) | control |
| `BL` | long beep; followed by a level digit (`BL1`..`BL2`) | control |

Every command above goes out through the same 24-byte, CR-terminated feature report. The `Q`/`G` commands read; `S`/`C`/`F` commands write; `B` commands drive the beeper.

## Reading configuration

To read the reader's settings, issue the query commands and parse the hex payload of each reply. A typical sequence is `QRZ` (main config), then `QSV` (version/service), then `QDD` (device data). Each reply arrives as `R..` + ASCII hex; strip the three-character ack header, then decode the hex to bytes.

The `QRZ` payload is a byte block whose bytes are distributed into configuration fields, some with bit masks. The mapping below is the portion traced directly from the parser. It is partial: the block continues beyond these bytes, and the remaining bytes should be correlated against a live `QRZ` capture from your model before you treat them as settings. Do not assume an unlisted byte is unused.

| QRZ byte | Operation | Meaning |
| --- | --- | --- |
| 0 | `& 0x3F` | lead-character / display base value |
| 0 | `& 0x01` | a boolean flag bit |
| 1 | direct | parameter byte |
| 2, 3 | `(b2 << 8) \| b3` | a 16-bit count (e.g. a bit count) |
| 4 | direct | parameter byte |
| 5..n | direct / masked | further parameter bytes (not yet individually mapped) |

After decoding, the native library exposes the same values through named accessors (total bit count, ID bit count, lead/trail parity bit counts, ID and facility display lengths, delimiters, hold and lockout timeouts, and the config-flag booleans). Those accessors read specific offsets inside the decoded block, so once the full byte map is confirmed for your model, each named setting maps to a fixed byte (and, for the flags, a specific bit).

The fastest way to complete the map accurately: capture one real `QRZ` reply from your reader, note the model, and correlate known current settings against the bytes. One capture resolves the remaining offsets with certainty, which static analysis alone cannot guarantee per model.

## Writing configuration

Writes use the same ASCII transport. The write entry used by the USB config-write path issues an `FR` command, and individual settings are written with the `S`/`C` family (for example `SL0` followed by two hex bytes, and `CD0`). Payload bytes are sent as ASCII hex, two uppercase characters per byte, matching the `%02X` encoding the reader expects.

Sequence for a setting write:

1. Build the command string (e.g. `SL0`).
2. Append the payload bytes as ASCII hex.
3. Append a carriage return and send as a 24-byte feature report.
4. Read the reply and confirm the reader accepted it.

Hardware-validation note, stated plainly because it affects real devices: the write commands and their encoding are established, but the exact per-page byte order of a full configuration write is model-specific and is the one area static analysis cannot pin down with certainty. A wrong offset on a write can misconfigure or brick a reader, and these are physical-access-control devices. Confirm the write layout against a reader you can safely re-flash before writing to production hardware. The reliable way to establish it is to read the current config (`QRZ`), change one setting through the vendor tool, read again, and diff the two payloads; the changed byte is that setting's position. That diff, per setting, gives a write map you can trust.

This is not a gap left for convenience — it is the honest boundary of what the binary tells you versus what the device confirms.

## Beeper and indicators

The beeper is driven through the ASCII command transport, not a binary opcode. The USB beep builds a two-letter command plus a level digit and sends it as a normal 24-byte, CR-terminated feature report.

- Short beep: `BS` + level, where level is clamped to 1..5 → `BS1`..`BS5`.
- Long beep: `BL` + level, where level is clamped to 1..2 → `BL1`..`BL2`.

The level is converted to its ASCII digit (value + 0x30). In the native entry point, the first argument is the level and the second selects short versus long: zero gives `BS`, non-zero gives `BL`.

LED and relay control exist as separate operations (set LED state, set beeper/relay control). These take a control structure rather than a single value; the field layout follows the same decode-to-struct pattern as the config block, so treat specific LED/relay byte positions as Runtime-confirm until checked against your model. The beep commands above are Confirmed.

## Card reading

Reading the active badge ID is not a raw poll; it is debounced and cached so one physical tap produces one stable event.

The logic: on each read, compute the time since the last hardware poll. If it is under \~235 ms, return the cached result rather than touching the hardware; within that window, if the time since the last read is under the configured ID-hold timeout, the cached ID is returned, otherwise the cache is cleared (the card is treated as gone). If 235 ms or more have elapsed, poll the hardware, cache the result, and return it. The return value is the ID length in bits.

```text
short GetActiveID(buf, bufLen) {
    lock;
    result = cachedBitCount;
    if (activeDev valid) {
        elapsed = now - dev.lastReadTick;
        if (elapsed < 235) {
            if (elapsed < idHoldTimeout) { copy cachedID -> buf; result = cachedHeldBitCount; }
            else { clear cachedID; result = 0; }
        } else {
            result = pollHardware(buf, bufLen);   // per transport
            cache(buf); cachedHeldBitCount = result;
        }
    }
    unlock;
    return result;   // ID bit count
}
```

Delivery of the ID is model-dependent: some readers return it in a feature report (read it after a tap), others push it as an input report. A robust host both polls `getActiveID` and listens for input reports. The ID byte layout within a report (offset and length) comes from the reader's bit-count and display-parameter settings; extract it per the config rather than assuming a fixed slice. The 235 ms throttle and the hold-timeout behaviour are Confirmed; the per-model ID byte layout is Runtime-confirm.

## Secure data channel

Alongside the ASCII protocol, there is a binary command channel for secure data. It is reached only when the active device uses the `+0xc == 1` USB backend; on other backends the secure calls return failure without doing anything.

The read builds an 8-byte command frame and exchanges it as a feature report:

```text
byte 0 : report id (carried separately in WebHID)
byte 1 : opcode 0x89  (secure read)
byte 2 : 0x10         (length field, 16)
byte 3 : 0x00         (reserved)
byte 4 : 0x00         (reserved)
byte 5..: parameters  (address / block from the caller)
```

It is sent with SET\_FEATURE, the response is read with GET\_FEATURE into the back half of the buffer, and the reply is polled for its response marker. The write side mirrors this with its own implementation.

No software cryptography is present in the library. A scan of the code finds no AES, SHA, or MD5 constant tables; the only cryptographic-looking table is a standard CRC-32 used for integrity. The `SetHashKeyData` call ships a key to the reader, but any encryption or authentication happens in the reader firmware, not on the host. The one real host-side cryptographic operation is Authenticode verification via the OS (used by the tamper check), which is not in-library crypto.

Status: the 0x89 frame layout and the backend gate are Confirmed; the response parsing and any additional opcodes are Runtime-confirm.

## Reliability behaviors

These behaviours are built into the library and worth matching in any host so the reader behaves the same way.

- Feature-write retry: up to 6 attempts, 80 ms apart, before reporting failure.
- Poll throttle: hardware is not polled for the active ID more than about once per 235 ms; reads inside that window return cached data.
- ID hold: a scanned ID is held for a configurable timeout (from the reader's time parameters) so a single tap reads as one event; after the hold expires the cache clears.
- Thread-safety: every device operation takes a shared lock, so calls from multiple threads are serialized.
- Report size: feature reports, including the report-id byte, stay within 25 bytes; config/beeper commands use a 24-byte report.
- Command termination: every ASCII command ends with a carriage return (0x0D).

## Status accounting

Every element in this reference, with its status, so nothing is left implicit.

| Element | Status | Note |
| --- | --- | --- |
| VID/PID identity, device paths | Confirmed | from the device table |
| WebHID keyboard-wedge visibility rule | Confirmed | browser security behaviour |
| Three transports exist (USB/serial/network) | Confirmed | distinct connect paths |
| `+0xc` numeric → transport label | Runtime-confirm | conflicting static evidence; several values reach USB HID |
| HID feature-report transport (GET/SET\_FEATURE) | Confirmed | handle at device +0x10 |
| 25-byte report cap, report-id byte | Confirmed |  |
| 6× / 80 ms write retry | Confirmed |  |
| ASCII command framing (CR, 24-byte report) | Confirmed |  |
| Q→R ack convention, hex payloads | Confirmed |  |
| Command set (QRZ/QSV/QDD/QS0/QUP/GS0/GL0/SL0/CD0/FR/BS/BL) | Confirmed | from the command table |
| QRZ field map, bytes 0–4 | Confirmed | masks as listed |
| QRZ field map, bytes 5…n | Runtime-confirm | correlate with a live capture |
| Config write commands exist | Confirmed | FR / SL0 / CD0 |
| Full write byte layout per setting | Runtime-confirm | diff-based capture recommended |
| Beep commands BS1–BS5 / BL1–BL2 | Confirmed | level clamps as listed |
| LED / relay field layout | Runtime-confirm | struct-decoded like config |
| Card read debounce (235 ms) + hold timeout | Confirmed |  |
| Per-model ID byte offset/length in a report | Runtime-confirm | from bit-count/display settings |
| Secure-data binary frame (opcode 0x89) | Confirmed | 8-byte frame as shown |
| Secure-data backend gate (`+0xc == 1`) | Confirmed |  |
| Secure-data response parsing, extra opcodes | Runtime-confirm |  |
| No host-side software crypto (CRC-32 only) | Confirmed | no AES/SHA/MD5 tables |

## End-to-end checklist

Bringing a reader up over USB, in order:

1. Serve over https (or localhost) and trigger device selection from a user gesture. Filter on vendor id 0x0C27 and 0x19E5.
2. If the reader does not appear, switch it out of keyboard-wedge mode into a vendor/HID-CDC mode so WebHID can see it.
3. Open the device. Note the report id in use (0 or 1).
4. Read configuration: send `QRZ`, confirm the `RRZ` ack, decode the hex payload; repeat with `QSV` and `QDD` as needed.
5. Establish the field map for your model: diff two `QRZ` captures taken before and after changing one setting in the vendor tool; each changed byte localizes one setting. Build your read/write map from these diffs.
6. Write a setting: compose the write command (e.g. `SL0` + hex payload, or `FR`), send it as a 24-byte CR-terminated report, and re-read to confirm. Validate on a re-flashable reader first.
7. Beep to confirm control: `BS1`..`BS5` (short) or `BL1`..`BL2` (long).
8. Read cards: call the active-ID read on a timer and also handle input reports; honor the 235 ms throttle and the hold timeout; extract the ID bytes per your confirmed layout and treat the bit count as the ID length.
9. For secure data (only on the `+0xc == 1` USB backend): send the 8-byte opcode-0x89 frame and read the response.

With steps 4–6 grounded in a capture from your actual model, the result is a reader you can both read and program with confidence; steps 1–3, 7–9 work from this document as written.
