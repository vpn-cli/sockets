# Sportz: Real-Time Sports Event Streaming Platform

Agent instructions and architectural reference for the Sportz codebase.

## Technology Stack

- **Frontend (`sportz-frontend-main`)**: React 19, TypeScript, Vite, Tailwind CSS.
- **Backend (`sportz-websockets-main`)**: Node.js (ESM), Express 5, `ws` (native WebSockets), Arcjet security/rate-limiting.
- **Database & ORM**: PostgreSQL (hosted on Neon with connection pooling) via Drizzle ORM (`drizzle-orm`, `drizzle-kit`).
- **Testing**: Vitest for both backend WebSocket integration tests and frontend hooks/utilities unit tests.
- **Background Worker**: Standalone Node.js seeder (`src/seed/seed.js`) generating high-frequency match events.

## Architecture & Real-Time Flow

```
[React 19 / Vite UI] <== (WebSockets: ws://host:8000/ws) ==> [Express + ws Server]
                                                                    ^
                                                              (HTTP POST /matches)
                                                                    |
                                                          [Background Seeder Worker]
                                                                    |
                                                           [Drizzle ORM / Neon DB]
```

1. **REST Endpoints (`/matches`, `/matches/:id/commentary`)**: Express routes for fetching matches and inserting events.
2. **WebSocket Server (`src/ws/server.js`)**: Upgrades HTTP connections to `/ws`. Handles subscriptions (`subscribe`, `unsubscribe`, `ping`), emoji reactions, and live broadcasts (`commentary`, `score_update`, `match_created`).
3. **Heartbeat & Protection**: Heartbeat interval terminates unresponsive sockets; Arcjet protects against abuse (bypassed on localhost/127.0.0.1).

## Essential Commands

From workspace root:
- `npm run dev` - Start backend and frontend simultaneously with live reloading.
- `npm test` - Run full Vitest test suites for both backend and frontend.
- `npm run build` - Build the production frontend distribution.
- `npm run seed` - Run the simulated event seeder worker.
- `npm run db:migrate` - Execute Drizzle migrations against Neon DB.

Component-specific:
- Backend tests: `npm --prefix sportz-websockets-main test`
- Frontend tests: `npm --prefix sportz-frontend-main test`

## Development & Testing Rules

- Keep tests fast and completely DB-independent by injecting or mocking database access.
- When modifying WebSocket logic, always verify heartbeat intervals, connection teardown, and subscription cleanup.
- Keep commits small, frequent, and well-described using Conventional Commits (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`).
