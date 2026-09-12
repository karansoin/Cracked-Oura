<div align="center">
  <img src="frontend/public/icon.png" alt="Cracked Oura Logo" width="128">
  <h1>Cracked Oura</h1>
  <p><b>Your Oura ring data, read straight from the ring, stored only on your machine.</b></p>
</div>

---

Cracked Oura is a local desktop app for Oura ring owners. It connects to the ring
over Bluetooth, downloads what the ring measured, and shows it in a customizable
dashboard with an optional local AI analyst. It never contacts Oura: no account,
no login, no cloud API, no telemetry.

**Data sources**

1. **Your ring, over Bluetooth** — heart rate, HRV, sleep stages, skin
   temperature, activity, battery. See [docs/BLE.md](docs/BLE.md) for how pairing
   works and the one trade-off (the ring can be paired with either this app or the
   Oura app, not both at once).
2. **An Oura data-export ZIP you already have** — drop it on the Data & Sync
   panel to import full history including Oura's scores.

**Live sessions** (Live page) stream the ring's accelerometer and beats over
Bluetooth for guided recordings the phone app does not offer: a steadiness test
(rest and postural hand oscillation by frequency band), workout recording with
activity timeline, cadence, reps, heart-rate zones, recovery and training load,
paced breathing with resonance scoring, and an orthostatic stand test. The Trends
page adds overnight baselines: each night's resting HR, HRV, skin-temperature
deviation, breathing rate and sleep compared with your own trailing 60 nights,
with change-point alerts and a fully documented readiness formula. Every number
shows the formula behind it; nothing is a diagnosis. All of it can be tried
without a ring through the built-in simulator.

## Install (macOS)

1. Download the `.dmg` from the Releases page and drag the app to Applications.
2. The app is not notarized; on first launch run
   `xattr -cr "/Applications/Cracked Oura.app"` if macOS says it is damaged.
3. Allow Bluetooth when asked (System Settings → Privacy & Security → Bluetooth).
4. Open **Ring → Scan → Pair**, or **Data & Sync → Import ZIP**.

## Build from source

```bash
git clone https://github.com/karansoin/Cracked-Oura.git
cd Cracked-Oura

# backend (Python 3.11)
cd backend && python3 -m venv venv && ./venv/bin/pip install -r requirements-dev.txt && cd ..

# frontend + Electron
cd frontend && npm install && npm run dev
```

`npm run dev` starts the Vite dev server, the Python backend (from `backend/venv`)
and Electron. Tests: `backend/venv/bin/python -m pytest backend/tests -q`.

Production build (PyInstaller-bundled backend + electron-builder):

```bash
cd frontend && npm run build
```

## Optional: local AI analyst

Install [Ollama](https://ollama.com), pull a tool-capable model
(`ollama pull llama3.1` recommended; `llama3.2:3b` works but is weaker), and pick
it in Settings → AI Analyst. Any OpenAI-compatible server (LM Studio, llama.cpp)
works too. The analyst runs read-only SQL against your local database; it cannot
modify data.

## Repository layout

| Path | Contents |
|---|---|
| `backend/src/ble/` | Ring protocol, event decoders, BLE client, sync manager, derivation |
| `backend/src/ingestion/` | Offline export-ZIP importer |
| `backend/src/api/` | Local FastAPI service (`127.0.0.1:8000`) |
| `backend/src/llm.py` | AI analyst |
| `frontend/src/` | React dashboard (Vite, Tailwind, shadcn/ui, Chart.js) |
| `frontend/electron/` | Electron main process |
| `docs/` | [Codebase audit](docs/CODEBASE_AUDIT.md), [BLE guide](docs/BLE.md) |

## Status and credits

This is a fork of [EIrno/Cracked-Oura](https://github.com/EIrno/Cracked-Oura),
rebuilt to work without any Oura service. The Bluetooth protocol knowledge comes
from the public reverse-engineering work of
[open_oura](https://github.com/Th0rgal/open_oura),
[open_ring](https://github.com/LogosIsLife/open_ring),
[ringverse/protocol](https://github.com/ringverse/protocol) and
[Defying/oura-ring4-ble](https://github.com/Defying/oura-ring4-ble); the code here
is an independent implementation of the documented byte layouts.

Not affiliated with Oura Health Oy. Use at your own risk.
