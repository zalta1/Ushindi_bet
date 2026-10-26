# Aviator presentation demo

Standalone client demo. Fake names, fake credit, and an in-memory round log. It does not import the real site, open a database, or move money.

```bash
cd aviator-demo
npm install
npm test
npm run dev          # API on 127.0.0.1:5181
npm run dev:web      # UI on http://127.0.0.1:5180
```

Or, from this folder:

```bash
docker compose up --build
```

Open http://127.0.0.1:5180 for the player screen and http://127.0.0.1:5180/admin for the presenter screen. Both show **DEMO - no real money**.

Automatic rounds use the same bustabit-style SHA-256 crash as the real Aviator game (client seed `demo`, RTP 96, cap 1000). The hash is published when the round opens. The seed is shown after the plane flies away.

Presenter controls apply to the **next** round only:

- crash multiplier (1.10–100)
- takeoff, how long betting stays open
- fly away, how long the flight lasts (`0` keeps the natural curve)
- mark selected players to win — they cash out 0.01x under the crash
- **Automatic** clears that queue and returns the following round to the hash

This folder is not an npm workspace and it is not a service in the real compose file.
