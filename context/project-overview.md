# Project Overview

## About the Project

Sportz is a real-time sports match dashboard. It provides live match updates, scores, and commentary through a reliable WebSocket connection, ensuring that fans are always up to date with the latest action.

The defining requirement of the runtime is resilience and real-time data delivery: the application gracefully handles connection drops, manages reconnection attempts with exponential backoff, and ensures isolated error handling in the UI so that a failed match query does not break the entire dashboard.

---

## Core Technologies

### Frontend
- **Framework:** React (via Vite)
- **Language:** TypeScript
- **Styling:** Tailwind CSS / vanilla CSS
- **Key Features:** Custom hooks for WebSocket management (`useWebSocket`), robust state management for pagination and live feeds.

### Backend
- **Runtime:** Node.js
- **Framework:** Express
- **Real-time:** `ws` (WebSockets)
- **Database:** PostgreSQL
- **ORM:** Drizzle ORM
- **Other Tools:** Zod for validation, Arcjet for security/rate limiting, dotenv for environment management.

---

## Pages & User Flow

```text
/                  → Dashboard displaying live match cards, a live commentary feed, and connection status.
```

### Dashboard Interactions
- **Match Setup:** The user sees a paginated setup of current ongoing or upcoming matches.
- **Real-time Live Feed:** Selecting "Watch Live" on a match card subscribes the frontend to the backend WebSocket stream for that match, rendering commentary updates in real-time.
- **Connection Status:** A distinct top-level connection indicator clearly displays when the connection is live, establishing, or broken.
- **Error Handling:** Should the API fail to fetch details, a clear visual fallback message is provided with a retry prompt.

---

## Data Architecture

### Matches and Commentary
- Stored in a standard PostgreSQL database schema managed by Drizzle ORM (`src/db/schema.js`).
- **REST Endpoints:** Basic CRUD operations and historical data loading are handled through REST endpoints (`/matches`, `/matches/:id/commentary`).
- **WebSockets:** Live updates regarding match scores and events are broadcasted through a centralized WebSocket upgrade server (`src/ws/server.js`).

---

## Features In Scope

- Real-time match score boards with instant updates.
- Real-time commentary feed streaming.
- Intelligent connection resilience (WebSocket reconnection, exponential backoff, error handling).
- Pagination of matches.
- A well-architected separation of static historical data (REST) and real-time updates (WebSockets).

---

## Target User

Sports enthusiasts or admins looking to monitor the live status of multiple sports matches concurrently and interact with granular commentary logs.

---

## Success Criteria

- Frontend correctly handles WebSocket events and displays score and commentary without refreshing.
- Fallback behaviors execute properly when the network is unstable.
- Backend efficiently multiplexes broadcasts to relevant clients without bottlenecking.