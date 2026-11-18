# ⚽ Sportz: Real-Time Event & Match Dashboard

> **Live Production Dashboard:** [https://sportz-rho.vercel.app](https://sportz-rho.vercel.app)  
> High-performance, bi-directional real-time sports dashboard powered by **React 19**, **Node.js**, **WebSockets**, **Neon Serverless PostgreSQL**, and **Arcjet**.

---

![React](https://img.shields.io/badge/React_19-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white)
![WebSockets](https://img.shields.io/badge/WebSockets-010101?style=for-the-badge&logo=socketdotio&logoColor=white)
![Neon PostgreSQL](https://img.shields.io/badge/Neon_Postgres-00E599?style=for-the-badge&logo=postgresql&logoColor=black)
![Drizzle ORM](https://img.shields.io/badge/Drizzle_ORM-C5F74F?style=for-the-badge&logo=drizzle&logoColor=black)
![Arcjet Security](https://img.shields.io/badge/Arcjet_Security-FF5722?style=for-the-badge&logo=shield&logoColor=white)

---

## 📋 Overview

**Sportz** is an enterprise-grade, real-time sports match dashboard engineered to demonstrate resilient bi-directional streaming and decoupled client-server architecture. The application simulates a live sports broadcast environment where high-frequency match events, score mutations, and granular commentary are pushed continuously to connected clients with sub-second latency.

Instead of relying on heavy HTTP short-polling or unidirectional Server-Sent Events (SSE), Sportz establishes a persistent full-duplex **WebSocket connection**. When match events or score updates are committed to the database, the backend immediately fans out targeted payloads to all subscribed clients without requiring client polling or full page refreshes.

---

## 🏗️ System Architecture

```mermaid
flowchart TD
    subgraph Clients["Clients (React 19 / Vite / Tailwind)"]
        C1["Client Sockets 1..2,500\n(Instance 1 Subscribers)"]
        C2["Client Sockets 2,501..5,000\n(Instance 2 Subscribers)"]
    end

    subgraph Cluster["Horizontal Backend Cluster (Node.js / Express 5 / ws)"]
        subgraph Inst1["Backend Instance 1 (Port 8000)"]
            WS1["WebSocket Server 1\n• In-Flight Replay Coalescing\n• Concurrent Replay Cap (5)\n• 500-Seq Ring Buffer Dedupe"]
            REST1["REST API / Health"]
        end
        subgraph Inst2["Backend Instance 2 (Port 8001)"]
            WS2["WebSocket Server 2\n• In-Flight Replay Coalescing\n• Concurrent Replay Cap (5)\n• 500-Seq Ring Buffer Dedupe"]
            REST2["REST API / Health"]
        end
    end

    subgraph Redis["Distributed Backplane (Redis 7)"]
        PubSub["Redis Pub/Sub\nsportz:match:id & sportz:global"]
        Hash["Atomic Reaction Hashes\nHINCRBY & HGETALL"]
    end

    subgraph Storage["Persistence Layer"]
        Drizzle["Drizzle ORM\n(Connection Pooling)"]
        Postgres[("Neon Serverless PostgreSQL\n(Matches & Commentary Tables)")]
    end

    subgraph Ingestion["Ingestion Engine"]
        Runner["Live Ingestor Runner\n(live-runner.js)"]
        Resolver["Match Resolver\n(match-resolver.js)"]
    end

    subgraph External["External Sports Provider"]
        Provider["football-data.org\n(REST API / Free Delayed Tier)"]
    end

    C1 <==>|WebSockets /ws| WS1
    C2 <==>|WebSockets /ws| WS2

    WS1 <==>|Pub / Sub / HINCRBY| Redis
    WS2 <==>|Pub / Sub / HINCRBY| Redis

    WS1 -->|Gap Replay Queries| Drizzle
    WS2 -->|Gap Replay Queries| Drizzle
    REST1 -->|Matches & Commentary| Drizzle
    REST2 -->|Matches & Commentary| Drizzle
    Drizzle <==>|TLS / TCP Pool| Postgres

    Provider -->|Polled Fixtures & Scores| Resolver
    Resolver --> Runner
    Runner -->|HTTP POST Events & Scores| REST1
```

### Architectural Pillars

1. **Decoupled Ingestion Pipeline**:
   - A standalone background data seeder simulates high-velocity real-world match events (goals, wickets, 6s, 4s, fouls, yellow/red cards).
   - Events are ingested via clean REST endpoints (`/matches/:id/commentary` and `/matches/:id/score`), mirroring external sports radar webhooks.
2. **Serverless Persistence with Neon PostgreSQL**:
   - Migrated to **Neon Serverless PostgreSQL** with connection pooling (`sslmode=require`) to prevent connection pool exhaustion and eliminate idle database pausing.
   - Managed via **Drizzle ORM** with compile-time type-safety and instantaneous zero-downtime schema migrations.
3. **Resilient WebSocket Hub**:
   - Centralized `ws` server attached to Node's HTTP upgrade lifecycle.
   - Broadcasts match mutations globally (`score_update`, `match_created`) and delivers granular play-by-play commentary (`commentary`) to match-specific subscriber sets.
   - Includes 30-second heartbeat ping/pong sweeps and client reconnection handling with exponential backoff.
4. **Arcjet Perimeter Security**:
   - Enterprise security rules protect REST endpoints from bot scraping and request spamming.
   - Enforces rate-limiting on WebSocket upgrade handshakes while maintaining seamless local development throughput.

---

## ✨ Key Features

- **🔴 Instant Score Synchronization**: Real-time score changes trigger animated badge highlights across match cards without page reloads.
- **⚡ Interactive Event Simulator Playground**: Built-in modal allowing developers and recruiters to simulate custom live events on-demand (e.g. Goals, Wickets, 6 Runs, Red Cards) across Football, Cricket, and Basketball.
- **🎙️ Rich Live Commentary Feed**: Dynamic play-by-play commentary stream styled with event-specific visual badges and a dedicated "⭐ Highlights" toggle.
- **🏷️ Sport & Status Filters**: Instant filtering across **Football ⚽**, **Cricket 🏏**, and **Basketball 🏀**, paired with status toggles (**All**, **Live 🔴**, **Scheduled**, **Finished**).
- **🔍 Real-Time Search**: Instant fuzzy filter by team names or sports categories.
- **🛡️ Bulletproof WebSocket Engine**:
  - Independent `useWebSocket` hook with detached listener lifecycles to prevent stale socket callback leaks.
  - Exponential backoff reconnection (`1s` to `30s`) that preserves user subscription state across network drops.
  - Zero-flicker connection status indicator (`LIVE CONNECTED`, `RECONNECTING...`, `OFFLINE`).

---

## 🛠️ Tech Stack & Engineering Decisions

| Domain | Technology | Justification |
| :--- | :--- | :--- |
| **Frontend Framework** | **React 19 + Vite 6** | Instant HMR, blazing-fast builds, and modern concurrent React features. |
| **Frontend Language** | **TypeScript 5.8 (Strict)** | Strict end-to-end interface typing shared across REST responses and WebSocket packets. |
| **Styling** | **Tailwind CSS + Neo-Brutalist Tokens** | Bold, accessible UI system with hard borders, curated contrast palettes, and zero hardcoded magic numbers. |
| **Backend Runtime** | **Node.js 20+ & Express** | Lightweight, event-driven I/O ideal for concurrent WebSocket multiplexing. |
| **Real-time Protocol** | **Native WebSockets (`ws`)** | Persistent bi-directional TCP communication with minimal frame overhead compared to SSE or Polling. |
| **Database** | **Neon PostgreSQL** | Serverless Postgres with automatic autoscaling, instant branching, and connection pooling. |
| **ORM** | **Drizzle ORM & Drizzle Kit** | Zero-overhead SQL generation with TypeScript schema definition, beating heavy runtime engines on cold starts. |
| **API & Upgrade Security** | **Arcjet** | IP-aware rate limiting, bot detection, and handshake protection against DDoS attacks. |

---

## 📁 Repository Structure

```text
sportz/
├── context/                             → Architecture, UI tokens, standards & build plan
│   ├── architecture.md
│   ├── code-standards.md
│   ├── progress-tracker.md
│   └── ui-tokens.md
├── sportz-frontend-main/                → Client application (React 19 + Vite + Tailwind)
│   ├── components/                      → MatchCard, LiveFeed, EventSimulatorModal, StatusIndicator
│   ├── hooks/                           → useMatchData.ts, useWebSocket.ts
│   ├── services/                        → Axios REST API client
│   ├── types.ts                         → TypeScript domain models & WS message types
│   └── vite.config.ts
├── sportz-websockets-main/              → Backend service (Express + ws + Drizzle ORM)
│   ├── drizzle/                         → PostgreSQL schema migration files
│   ├── src/
│   │   ├── db/                          → Drizzle schema & Neon pool connection
│   │   ├── routes/                      → /matches and /commentary endpoints
│   │   ├── seed/                        → Background automated match event simulator
│   │   ├── ws/                          → WebSocket server hub & subscription management
│   │   ├── arcjet.js                    → Arcjet rate-limiting & bot protection configuration
│   │   └── index.js                     → Express server entry point & WS upgrade listener
│   └── package.json
├── dev.js                               → Root concurrent dev runner script
├── package.json                         → Workspace convenience commands
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v20.x or higher
- **npm** v10.x or higher
- A **Neon PostgreSQL** database connection string (or any standard PostgreSQL instance)

---

### Quick Start (Concurrent Root Runner)

You can install dependencies and launch both the backend and frontend concurrently from the root directory:

```bash
# 1. Install dependencies in both projects
npm --prefix sportz-websockets-main install
npm --prefix sportz-frontend-main install

# 2. Run database migrations
npm run db:migrate

# 3. Launch both services concurrently
npm run dev
```

The frontend will be available at **`http://localhost:5173`** and the backend at **`http://localhost:8000`**.

---

### Manual Step-by-Step Setup

#### 1. Backend Service (`sportz-websockets-main`)

```bash
cd sportz-websockets-main

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

Edit `.env` with your credentials:
```env
DATABASE_URL="postgresql://user:password@endpoint.neon.tech/neondb?sslmode=require"
PORT=8000
HOST="0.0.0.0"
ARCJET_KEY="your_arcjet_key_here" # Optional in development
ARCJET_ENV="development"
```

Push database migrations and start the server:
```bash
# Push schema or run migration to Neon PostgreSQL
npm run db:migrate

# Start server (automatically launches background match seeder)
npm run dev
```

#### 2. Frontend Service (`sportz-frontend-main`)

```bash
cd sportz-frontend-main

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
```

Verify your frontend `.env`:
```env
VITE_API_BASE_URL="http://localhost:8000"
VITE_WS_BASE_URL="ws://localhost:8000/ws"
VITE_DEV_PORT="5173"
```

Start the Vite development server:
```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

### Root Workspace Commands

You can run and test both services directly from the workspace root:

```bash
# Start backend and frontend simultaneously
npm run dev

# Run full Vitest test suites (backend integration + frontend unit tests)
npm test

# Build production frontend
npm run build

# Run database migrations
npm run db:migrate

# Seed simulated match data
npm run seed
```

### Running Test Suites

Sportz uses **Vitest** for fast, reliable testing without requiring real database credentials:

```bash
# Run all tests across the workspace
npm test

# Run backend WebSocket integration tests (spawns real ephemeral ws servers)
npm --prefix sportz-websockets-main test

# Run frontend unit tests (reconnect backoff and utilities)
npm --prefix sportz-frontend-main test
```

---

## 📡 API Reference

### REST Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Healthcheck returning server status and timestamp. |
| `GET` | `/matches?limit=100` | Fetch all matches with scores, status, and sport types. |
| `POST` | `/matches` | Create a new match (triggers real-time broadcast). |
| `GET` | `/matches/:id/commentary` | Fetch chronological commentary history for a match. |
| `POST` | `/matches/:id/commentary` | Ingest new commentary entry (fans out to match subscribers). |
| `POST` | `/matches/:id/score` | Update match score (broadcasts globally to all clients). |

---

### WebSocket Protocol (`ws://localhost:8000/ws`)

#### Client to Server
```json
// Subscribe to match commentary
{ "type": "subscribe", "matchId": 1 }

// Unsubscribe from match commentary
{ "type": "unsubscribe", "matchId": 1 }

// Application heartbeat
{ "type": "ping" }
```

#### Server to Client
```json
// Real-time score update (Global)
{
  "type": "score_update",
  "matchId": 1,
  "data": { "homeScore": 2, "awayScore": 1 }
}

// Live play-by-play commentary (Subscribed Match)
{
  "type": "commentary",
  "data": {
    "id": 104,
    "matchId": 1,
    "minute": 42,
    "sequence": 12,
    "period": "1st half",
    "eventType": "goal",
    "actor": "Bukayo Saka",
    "team": "Arsenal FC",
    "message": "Goal! A composed finish from close range.",
    "createdAt": "2026-10-14T18:30:00.000Z"
  }
}

// Server welcome greeting
{ "type": "welcome" }
```

---

## 🧪 Interactive Testing with the Event Simulator

Sportz comes with a built-in **Event Simulator Playground**:
1. Click the **`⚡ Simulate Event`** button in the dashboard header.
2. Select any active match from the dropdown.
3. Pick an event type (**Goal ⚽**, **Wicket 🏏**, **6 Runs**, **4 Runs**, **Foul 🏀**, **Yellow Card**, **Red Card**).
4. Enter custom player/team details and click **Broadcast Event**.
5. Watch the live commentary panel and match cards react in real time without refreshing!

---

## 📊 Scale & Resilience Benchmarks

All metrics are captured using automated benchmark scripts executing against live backend instances connected to real standalone Redis (`redis:7-alpine`) and Neon Serverless PostgreSQL with zero simulated or rounded numbers.

### Machine & Environment Specifications
- **Host Machine**: Laptop running Windows 11 Home Single Language (x64)
- **CPU**: AMD Ryzen 7 6800H with Radeon Graphics (8 Physical Cores, 16 Logical Processors @ 3.20 GHz base, boost up to 4.7 GHz)
- **Memory**: 16.0 GB DDR5 RAM (15.26 GiB visible)
- **Runtime**: Node.js v24.15.0 (V8 engine)
- **Network / Clocks**: Local loopback (`127.0.0.1`), eliminating NTP clock drift between emission and reception timestamps.

### Load Generator Execution Flags
To ensure fair, repeatable measurements without synthetic socket starvation or memory leaks, every benchmark run uses identical V8 runtime flags:
- `--max-old-space-size=4096`: Allocates 4 GB heap headroom to prevent aggressive V8 garbage collection compaction during 5,000-socket concurrency.
- `--expose-gc`: Enables explicit `global.gc()` sweeps between test runs to clean up transient socket metadata.
- **Socket RST Recycling (`ws.terminate()`)**: Forcefully terminates client sockets using TCP RST instead of standard 4-way FIN handshakes, bypassing the Windows 120-second `TIME_WAIT` socket delay and preventing ephemeral port pool exhaustion (`WSAENOBUFS`).

```powershell
node --max-old-space-size=4096 --expose-gc sportz-websockets-main/scripts/measure-undelivered-distribution.js
```

---

### 5-Run Benchmark Distribution Table (Workload Specified Per Metric)

**Workload Across All Rows**: 2 Instances × 5,000 Clients (2,500 per instance) across 5 match rooms (1,000 clients/room) receiving 25 broadcast rounds per run (125,000 deliveries/run; **625,000 total expected deliveries** across 5 runs) under a **2.0-second collection window**.

| Benchmark Run | Total Expected Deliveries | On-Time Deliveries ($\le$ 400ms SLA) | Missed > 400ms SLA | 400–500ms Bucket | 500–600ms Bucket | 600–800ms Bucket | >2000ms (Undelivered) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Run 1** (125k msgs) | 125,000 | 124,546 (**99.637%**) | 454 (0.363%) | 454 (I1: 205, I2: 249) | 0 | 0 | **0 (0.000%)** |
| **Run 2** (125k msgs) | 125,000 | 122,579 (**98.063%**) | 2,421 (1.937%) | 1,225 (I1: 630, I2: 595) | 1,196 (I1: 532, I2: 664) | 0 | **0 (0.000%)** |
| **Run 3** (125k msgs) | 125,000 | 119,429 (**95.543%**) | 5,571 (4.457%) | 3,253 (I1: 1,613, I2: 1,640) | 1,577 (I1: 812, I2: 765) | 741 (I1: 349, I2: 392) | **0 (0.000%)** |
| **Run 4** (125k msgs) | 125,000 | 125,000 (**100.0%**) | 0 (0.000%) | 0 | 0 | 0 | **0 (0.000%)** |
| **Run 5** (125k msgs) | 125,000 | 125,000 (**100.0%**) | 0 (0.000%) | 0 | 0 | 0 | **0 (0.000%)** |
| **5-RUN AGGREGATE** | **625,000** | **616,554 (98.649%)** | **8,446 (1.351%)** | **4,932 (58.4% of late)** | **2,773 (32.8% of late)** | **741 (8.8% of late)** | **0 (0.000%)** |

#### Key Performance Metrics
- **0 of 625,000 Lost Within 2s**: Exactly **0.000% dropped messages**. Every single message reached its target socket within the 2.0-second collection window.
- **Overall SLA Compliance**: **98.649% of all deliveries arrived within 400ms**.
- **Per-Run Range**: From **95.543%** (worst-case run under cumulative V8 heap churn) to **100.000%** (Runs 4 & 5 with fresh garbage collection).
- **Tail Latency**: The tail is strictly bounded at **639ms** (zero deliveries exceeded 639ms; zero deliveries in the 800–1000ms, 1000–1500ms, 1500–2000ms, or >2000ms buckets).

---

### Root Cause Analysis: Why Late Messages Cluster in ~100ms Steps

During load testing, late deliveries cluster into discrete ~100ms bands (`[401–454ms]`, `[501–543ms]`, `[603–639ms]`) with completely empty intervals between them. The underlying mechanics were investigated by tracking event loop delays (`perf_hooks.monitorEventLoopDelay`) across both the load generator and server instances:

1. **Room-by-Room Fan-Out Wave Discretization**:
   - The workload partitions 5,000 clients across **5 match rooms (1,000 clients per room: 500 on Instance 1, 500 on Instance 2)**.
   - When broadcast rounds fire, reactions are published room-by-room. The 2 server instances dispatch messages in **5 sequential waves of 500 sockets per instance** (1,000 sockets total per room wave).
2. **Single-Threaded V8 Processing Cadence**:
   - On the client side, a single Node.js process hosts all 5,000 client sockets.
   - Parsing, deserializing (`JSON.parse`), and appending 1,000 JSON payloads on a single V8 thread consumes **~80–100ms of CPU time**.
   - As a result:
     - Wave 1 (Room 1, 1,000 sockets): Processed in 0–100ms.
     - Wave 2 (Room 2, 1,000 sockets): Processed in 100–200ms.
     - Wave 3 (Room 3, 1,000 sockets): Processed in 200–300ms.
     - Wave 4 (Room 4, 1,000 sockets): Processed in 300–400ms.
     - Wave 5 (Room 5, 1,000 sockets): Queued in the OS socket buffer while the event loop drains prior waves, landing at **401–454ms** (Cluster 1: exactly 454–1,225 clients, corresponding to an integral room batch).
3. **Event-Loop Lag Spikes & GC Halts**:
   - In back-to-back runs without interim GC, V8 minor GC scavenges and kernel TCP socket buffer flushes introduce periodic **~100ms event-loop pauses**.
   - When a 100ms lag pause occurs during socket draining, subsequent room waves are shifted by exactly +100ms into **501–543ms** (Cluster 2) and an additional 100ms into **603–639ms** (Cluster 3).
   - Because clients belong to discrete 1,000-socket rooms, no messages exist in the intervals between room batches, creating the observed step-function distribution.

---

## 🔒 Security & Resilience

- **Arcjet Bot & DDoS Protection**: Analyzes incoming client request signatures and enforces rate limits before hitting sensitive database queries.
- **WebSocket Upgrade Verification**: Inspects upgrade requests at the HTTP server level to reject unauthorized or abusive connection spikes.
- **Connection Isolation**: The frontend cleans up stale listeners on superseded WebSocket instances, preventing orphaned socket event loops and UI jitter.
- **Safe Fallbacks & Degraded Mode**: If Redis disconnects mid-run, instances log loud degradation warnings and fall back to local-only broadcast without dropping messages on local sockets. When Redis reconnects, cluster subscriptions and reaction deltas automatically re-sync.
- **Client Gap Detection & Non-Reconnecting Recovery**: If a client receives sequence $N$ while its last seen sequence was $< N - 1$, the client automatically requests gap replay from its last contiguous sequence over its existing open socket without reconnecting.
- **Gap-Replay Stampede Coalescing**: When multiple clients request gap replay for the same match and sequence simultaneously, in-flight database queries are coalesced by `(matchId, lastSeq)`. 1,000 concurrent clients detecting the same gap fire **exactly 1 Postgres query** instead of 1,000.
- **Per-Client Replay with Concurrency Caps**: Clients can stream finished matches privately from Postgres at `1x` or `10x` speed without mutating global server state. Replays are governed by a 3-second per-socket cooldown and an instance-level concurrency cap (`MAX_CONCURRENT_CLIENT_REPLAYS`).

---

## ⚙️ Docker Pause vs. Outage Resilience & Deduplication

### Docker Pause Mechanics
- During `docker pause`, the TCP socket between Node and Redis remains open and connected; the `ioredis` connection status remains `"ready"`.
- Because the connection is ready, `ioredis` writes outgoing `PUBLISH` commands directly to the operating system's kernel TCP socket buffer, **not** to the client's internal offline queue.
- When the container is unpaused (`docker unpause`), the Redis server resumes processing socket bytes and fans out the delayed publish commands across the cluster.
- **Sequence Deduplication (`recentlyBroadcastSeq`)**:
  - To prevent clients from receiving duplicate messages that were already delivered locally during degraded mode, each backend instance maintains a `recentlyBroadcastSeq` ring buffer.
  - **Size Limit**: Bounded to **500 sequence numbers per match room**.
  - **Expiry Policy**: Strict FIFO capacity eviction (the oldest sequence number in the room's set is evicted once 500 items are reached).
  - When a message arrives from Redis pub/sub carrying a sequence number present in `recentlyBroadcastSeq`, the instance discards the message: **no duplicates observed in the pause test**.

---

## ⚠️ Known Limitations

1. **Delayed Free-Tier Provider Feed**:
   - The integrated `football-data.org` free-tier API provides match fixtures and scores with a provider-enforced broadcast delay. The UI prominently displays a `DELAYED` badge to indicate non-live latency.
2. **Events Derived From Score/Status Transitions Only**:
   - In automated ingestion mode without a paid live pitch telemetry webhook, commentary events and match status changes are synthesized from polled score and status mutations rather than sensor tracking.
3. **Reaction Counters Dropped Reply Over-Counting**:
   - Emoji reactions use atomic Redis `HINCRBY`. Each instance batches local deltas and clears each delta only after its own `HINCRBY` returns a successful reply.
   - **Edge Case**: If Redis successfully applies `HINCRBY` but the network reply is severed before reaching Node, the instance retains the delta and re-submits it upon reconnection, which may cause minor over-counting in rare network drop scenarios.
4. **500-Item Sequence Deduplication Buffer**:
   - Sequence deduplication (`recentlyBroadcastSeq`) maintains an in-memory FIFO buffer capped at 500 sequence entries per match. Outages generating more than 500 events per match before reconnection exceed the deduplication window.
5. **Single-Laptop Benchmarks**:
   - All horizontal scaling benchmarks (load generator, 2 server instances, Redis container, and 5,000 WebSocket connections) execute simultaneously on a single developer laptop, competing for the same 8 CPU cores, RAM bandwidth, and OS TCP loopback stack.
6. **Render Free-Tier Idle Sleep**:
   - Deployed on Render's free tier, the backend web service spins down after 15 minutes of inactivity. Initial cold-start requests incur a 30–50 second latency while the instance boots.

---

## 📄 License

MIT © [Sportz](https://github.com/vpn-cli/sockets)
