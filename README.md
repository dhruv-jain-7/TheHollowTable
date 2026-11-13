# The Hollow Table

A private-room, online social deduction horror game. Players join through a four-character table code; there is no public matchmaking.

## What is included

- Private four-character room codes and guest nicknames (no account required).
- 5–16 player rooms, configurable Mafia count, exactly one Sheriff and one Angel.
- Server-assigned secret roles. A player's browser only receives that player's own role and private results.
- Night actions: Mafia vote for one murder target (friendly fire is allowed, self-targeting is not), Sheriff investigates, Angel protects.
- Day discussion and private voting, changeable votes, five-minute tie-break, and no elimination if the tie remains.
- Round discussion clock: rounds 1–2 are 10 minutes, rounds 3–4 are 7.5 minutes, rounds 5–6 are 6 minutes, and round 7 onward is 4 minutes.
- Private Mafia text chat at night; public table chat during the day.
- Optional proximity-free group voice chat using LiveKit (requires LiveKit credentials).
- Guest seats that resume after a page refresh in the same browser tab, host hand-off when the host leaves or remains disconnected, server-authoritative timers, input validation, and join throttling.
- Optional PostgreSQL persistence for active room state.

## Run locally on Windows 11

The project requires Node.js 20.19+ (Node 22 LTS is recommended).

1. Extract the project ZIP.
2. Open the project folder in VS Code or Windows Terminal.
3. Install packages:

   ```powershell
   npm install
   ```

4. Create your local environment file:

   ```powershell
   Copy-Item .env.example .env
   ```

5. Start the app:

   ```powershell
   npm run dev
   ```

6. Open `http://localhost:5173` in your browser.

For local testing with multiple people on the same Wi-Fi, open the app using the computer's LAN IP and allow the relevant Node.js ports through Windows Firewall. For players on different networks, deploy the app to a public HTTPS host (see below).

## Optional voice chat

Text chat works without extra services. To turn on voice, create a LiveKit Cloud project and set these variables in `.env`:

```env
LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
```

The server creates short-lived participant tokens; API keys are never sent to browsers. Voice is available to living players during discussion and to Mafia during the night phase. Without these values, the game automatically falls back to text chat.

## Persistent rooms

Without a database, rooms are held in server memory. That is fine for local development, but a server restart will clear them.

For an internet deployment, create a persistent PostgreSQL database (for example, Supabase Postgres), then set:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
```

The server creates its `hollow_rooms` table automatically at startup; no manual SQL migration is required for this project. It saves room/game state after game actions and phase transitions. Player reconnect tokens are hashed before being stored. A guest seat is cached in that browser tab so a refresh can restore the seat without making separate tabs unexpectedly take over one another.

If your PostgreSQL provider does not support SSL on that connection, set `DATABASE_SSL=disable`. For most managed hosted databases, leave the default SSL setting enabled.

## Deploy to Render

This repository includes `render.yaml` as a starting point. The deployment is a single Node web service because the Express and Socket.IO server need to share the same origin for the least complicated WebSocket setup.

1. Push this folder to a GitHub repository.
2. In Render, create a new Blueprint and select the repository.
3. Provide a PostgreSQL connection string as `DATABASE_URL` (Supabase Postgres is suitable for a small test deployment). For Supabase on Render, use the **Session pooler** connection string because it supports IPv4-only networks.
4. Set `CLIENT_ORIGIN` to the exact deployed HTTPS origin (for example `https://the-hollow-table.onrender.com`). This is required by the production Socket.IO origin allowlist.
5. Optionally add the three LiveKit variables.
6. Deploy. The build command runs `npm install && npm run build`; the start command runs the production Node server.

The included Blueprint uses Render's **Free** web-service plan to avoid an automatic paid Starter instance. Free services spin down after 15 minutes without incoming traffic, so the first player after a quiet period may wait around a minute for the server to wake. This is suitable for testing, not a dependable always-on game server. Render Free Postgres databases expire after 30 days, so use a persistent external database such as Supabase for room storage.

The app uses one Node process and the Socket.IO in-memory adapter. Do not scale the service to multiple instances unless you also configure a shared Socket.IO adapter (such as the Redis adapter) and shared room ownership/locking. PostgreSQL persistence alone does not make Socket.IO rooms cross-instance.

## Game rules implemented

- Mafia selects a single target through private team voting. The most-selected living target is murdered; if Mafia votes are tied, the murder fails. A Mafia member may target another Mafia member; a player cannot target themselves.
- The Angel's protection prevents the murder if the protected player is the selected target. The Angel may protect themselves. Mafia may target another Mafia member, but not themselves.
- Sheriff results are private and report `MAFIA` or `NOT MAFIA`.
- Day votes are private. If the leading vote count is tied, a five-minute re-vote opens between the tied candidates only. If that second vote is tied, nobody is eliminated.
- Town wins when all Mafia are gone. Mafia wins when living Mafia equal or outnumber all other living players.
- Leaving during an active game forfeits that seat; disconnected players can still reconnect, while a deliberate leave removes the player from the living count.
- The host can start with 5 or more players. Mafia count is validated against the actual player count at game start, even if a higher number was configured for the room's maximum capacity.

## Tests

Run the game-rule unit tests:

```powershell
npm test
```

Create a production frontend build:

```powershell
npm run build
```

## Important production notes

This is a working first release / MVP codebase, not a security audit or a guarantee of unlimited scale. Before a large public launch, add monitoring, automated browser/e2e tests, persistent rate limiting (Redis), database transaction/locking for multi-instance deployments, and a moderation/reporting flow. The current room code is four characters by design; join attempts are rate-limited per IP, but a public production launch should also use a shared rate limiter and abuse monitoring.
