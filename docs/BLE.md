# Talking to the ring directly (Bluetooth Low Energy)

Cracked Oura reads your Oura ring **directly over Bluetooth**. Nothing is sent to
Oura, no account is used, and the phone app is not involved. This document
explains what the app does on the wire, what it needs from you, and the one
trade-off you must accept.

## The trade-off, in one paragraph

An Oura ring talks to **one device at a time** and only accepts a device that
was paired while the ring was in its factory-reset state. The Oura phone app
installs its own secret key during setup, and the ring then refuses any other
device. To use the ring with this app you therefore **factory-reset the ring
once and pair it here instead of with the Oura app**. From then on the Oura app
cannot read the ring (it will show "not paired") until you factory-reset it
again and set it up in the Oura app. You can always switch back; nothing is
permanently changed. Sync the Oura app one last time before resetting so you do
not lose the data still on the ring.

## Pairing steps

1. Put the ring on its charger (it advertises far more often there) and turn
   off Bluetooth on the phone that used to own the ring, or move it away.
2. Factory-reset the ring: Oura app → ring settings → *Reset ring*, or the
   hardware procedure for your charger (Gen 3 / Ring 4 dock: place the ring on
   the dock, wait ~2 s, flip the dock over → blue, back → red, over → magenta,
   back → yellow; a few minutes later it blinks blue. Ring 5: hold the charging
   case button per Oura's instructions). A blinking blue dock LED means "not
   paired with anything" and is the state you want.
3. In the app open **Ring → Scan**. A reset ring advertises as `Oura <serial>`;
   a ring that was bonded to a phone shows no name at all.
4. Click **Pair**. macOS shows its Bluetooth pairing dialog; click *Connect*.
   The app installs a random 16-byte key on the ring and stores it in
   `~/Library/Application Support/CrackedOura/ring-<serial>.key` (mode 0600).
   That file is the only copy; back it up if you care.
5. Click **Sync**. The app authenticates with the key, sets the ring's clock,
   enables the measurement features (daytime heart rate, SpO2, resting HR, real
   steps, workout HR) and downloads the ring's event history.

Sync again whenever you like. The ring keeps roughly a week of history in its
own flash memory; the app remembers where it stopped and only pulls new events.

## What comes off the ring

The ring emits a stream of timestamped **events**. The app stores every event
losslessly (`ring_event` table) and derives the dashboard tables from them:

| Ring event | Derived data |
|---|---|
| IBI + amplitude (`0x60`), green IBI (`0x80`) | heart-rate samples, nightly average and lowest HR |
| HRV (`0x5d`) | 5-minute HR + RMSSD series during sleep, nightly average HRV |
| Bedtime period (`0x76`) | sleep session start/end, time in bed |
| Sleep phases (`0x4b`, `0x4e`, `0x5a`) | hypnogram (deep / light / REM / awake), stage durations, efficiency |
| Temperature (`0x46`, `0x75`) | skin temperature series, nightly temperature deviation vs your 30-night baseline |
| Activity MET (`0x50`) | per-minute MET, active / sedentary minutes |
| Battery (`0x61`, state `0x45`) | battery history |
| SpO2 (`0x6f`, `0x8b`) | stored raw; SpO2 summary widgets are on the roadmap |

**What the ring does not give you:** Oura's 0–100 Sleep / Readiness / Activity
scores. Those are computed inside the phone app, not on the ring. For
ring-synced days the score gauges show "—" and every measured number is real.
If you also import an export ZIP, the scores from the export are kept.

## Protocol summary (for developers)

All facts below were established by public reverse-engineering projects
(open_oura, open_ring, ringverse, Defying/oura-ring4-ble) and re-implemented
here from the documented byte layouts; see `backend/src/ble/`.

* Service `98ed0001-a541-11e4-b6a0-0002a5d5c51b`; write `…0002`; notify
  `…0003` (Ring 4/5 add `…0004/5/6`, subscribed but unused).
* Frames are `tag | len | payload`, several per notification. Extended ops use
  tag `0x2f` with the sub-op in `payload[0]`.
* Link-layer bonding is mandatory (macOS pairing dialog). On top of it, every
  connection runs an app-auth challenge: `2f 01 2b` → 15-byte nonce →
  `AES-128-ECB(key, nonce‖0x01, PKCS5)[:16]` → `2f 11 2d <proof>` → `2f 02 2e 00`.
  The key is installed once with `24 10 <key>` on a factory-reset ring.
* Sync: `28 01 00` (flush), `10 09 <cursor:u32> ff ff ff ff ff` (get events),
  event frames…, `11 08 …` summary with `bytes_left`, then
  `10 09 <next_cursor> 00 ff ff ff ff` (acknowledge). The cursor is the ring's
  own clock in 100 ms ticks; `0x85` beacons (exact) and `0x42` time-sync events
  (±256 s) map it to wall-clock time.
* Live heart rate: `2f 03 22 02 03` (daytime HR, connected-live mode) then
  parse `2f xx 28 02 …` notifications; restore automatic mode afterwards.

## macOS notes

* Bluetooth permission is granted to the *app that launched the process*. The
  packaged app declares `NSBluetoothAlwaysUsageDescription`; in development the
  backend inherits Electron's permission. If a scan fails immediately, check
  System Settings → Privacy & Security → Bluetooth.
* CoreBluetooth identifies peripherals by a per-Mac UUID that can change
  between scans, so the app always connects from a fresh scan.
* A ring that is currently connected to a phone cannot be connected from the
  Mac (single link); the connect attempt times out after 45 s.

## Safety

The app never sends the factory-reset command, never touches firmware update
commands, and never changes ring modes other than enabling the standard
measurement features. Auth keys are never logged.
