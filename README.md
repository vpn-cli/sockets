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
graph TD;
    subgraph Client["Frontend Client (React 19 / Vite / Tailwind)"]
        UI[Match Cards & Live Feed UI]
        Hook[useWebSocket & useMatchData Engine]
        Sim[Interactive Event Simulator Modal]
    end

    subgraph Security["Edge Security Layer"]
        ArcjetRest[Arcjet Bot & Rate Limit Filter]
        ArcjetWS[Arcjet WS Upgrade Protection]
    end

    subgraph Backend["Backend Server (Node.js / Express / ws)"]
        Router[REST API: /matches, /commentary]
        WSServer[WebSocket Hub: ws://.../ws]
        Broadcaster[Score & Commentary Broadcaster]
    end

    subgraph Ingestion["Automated Data Ingestion"]
        Worker[Background Data Seeder Process]
    end

    subgraph Database["Persistence Layer"]
        Drizzle[Drizzle ORM Code-First Schema]
        Neon[(Neon Serverless PostgreSQL)]
    end

    Sim -->|HTTP POST| ArcjetRest
    Worker -->|HTTP POST Simulation| ArcjetRest
    ArcjetRest --> Router
    Router -->|Mutations| Drizzle
    Drizzle <--> Neon

    Router --> Broadcaster
    Broadcaster --> WSServer

    Hook <==>|WS Upgrade / TCP Socket| ArcjetWS
    ArcjetWS <==> WSServer
    Hook --> UI
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

## 🔒 Security & Resilience

- **Arcjet Bot & DDoS Protection**: Analyzes incoming client request signatures and enforces rate limits before hitting sensitive database queries.
- **WebSocket Upgrade Verification**: Inspects upgrade requests at the HTTP server level to reject unauthorized or abusive connection spikes.
- **Connection Isolation**: The frontend cleans up stale listeners on superseded WebSocket instances, preventing orphaned socket event loops and UI jitter.
- **Safe Fallbacks**: If the backend connection drops, the UI retains optimistic data, clearly reflects status via color-coded badges, and reconnects automatically using exponential backoff.

---

## 📄 License

MIT © [Sportz](https://github.com/vpn-cli/sockets)
