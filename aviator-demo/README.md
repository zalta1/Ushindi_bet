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

The presenter can run any number of odds (at least one). Press Start and they play back to back on the same growth curve as an Automatic round, with the usual betting break and no Automatic rounds in between. The time cap does not speed that curve. An odd that would take longer than the cap is flagged and still climbs at normal speed until it reaches the odd. Pause, Stop, and Clear are available. After the last odd, play returns to Automatic. The clock on the presenter screen is East African Time (EAT), which is Africa/Nairobi, UTC+3. A row can optionally mark the players selected in the table.

Presenter controls apply to the **next** round only:

- crash multiplier (1.10–100)
- takeoff, how long betting stays open
- fly away is kept on the form, and the flight still uses the natural curve
- mark selected players to win — they cash out 0.01x under the crash
- **Automatic** clears that queue and returns the following round to the hash

This folder is not an npm workspace and it is not a service in the real compose file.
