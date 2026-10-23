# Ushindi Bet — Sandbox Demo (No Real Money)
Original brand for Tanzania. No Betika branding/assets/code. See PLAN.md first.

## Run locally (no Docker)
```bash
cd /workspace/ushindi-bet
npm install
npm run dev:api   # Fastify API http://localhost:4000/health  (terminal 1)
npm run dev       # Vue web http://localhost:5173 (terminal 2)
```
Or web only (mock data works offline): `npm install && npm run dev`

## Docker
```bash
docker compose up --build
# web http://localhost:5173  api http://localhost:4000/health  postgres:5432 redis:6379
```

## What's mock
All money, odds, SMS (code 123456 shown in UI), payments (M-Pesa/Tigo/Airtel/HaloPesa sandbox), matches, KYC, admin. Crash uses client-side demo in web + provably-fair HMAC endpoints in API (/api/crash/current, /api/crash/start, RTP 97%).
Real launch requires Gaming Board of Tanzania licence + real payment/odds/KYC contracts — see PLAN.md §7.
