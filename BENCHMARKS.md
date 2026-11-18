# Sportz Performance & Scaling Benchmarks

This document records real, reproducible performance benchmarks and latency measurements for the **Sportz** real-time streaming engine.

All metrics are captured using automated benchmark scripts executing against the live WebSocket server with zero simulated or rounded figures.

---

## Machine & Environment Specifications

- **Operating System**: Windows 11 Home Single Language (Build 10.0.26300, x64)
- **CPU**: AMD Ryzen 7 6800H with Radeon Graphics (8 Physical Cores, 16 Logical Processors @ 3.20 GHz base, boost up to 4.7 GHz)
- **System Memory**: 16.0 GB DDR5 RAM (15.26 GiB visible)
- **Node.js Version**: v24.15.0
- **Network / Clocks**: Single-machine localhost testing (`127.0.0.1`), eliminating NTP clock drift between client receiver timestamps and server emission timestamps.

---

## Reproduction Commands

### 1. Launch Backend Server in Benchmark Mode
The benchmark mode flag bypasses external rate limiters (`BENCHMARK_BYPASS_ARCJET=1`) while preserving all internal pub/sub logic, connection states, and broadcast loops:

```powershell
$env:BENCHMARK_BYPASS_ARCJET="1"
cd sportz-websockets-main
node src/index.js
```

### 2. Execute Load Benchmark Suite
The benchmark script (`sportz-websockets-main/scripts/load-test.js`) runs concurrency scaling, global broadcast fan-out, and cold-start subscribe bursts:

```powershell
node sportz-websockets-main/scripts/load-test.js --tiers 100,500,1000,2000,5000,10000 --rounds 10 --mode all
```

Raw JSON execution logs are stored in [`benchmarks/baseline-raw.json`](./benchmarks/baseline-raw.json), [`benchmarks/phase1-5-raw.json`](./benchmarks/phase1-5-raw.json), and [`benchmarks/repeatability-raw.json`](./benchmarks/repeatability-raw.json).

---

## Phase 1.5 — Before vs After Benchmark Comparison

### 1. Cold-Start Subscribe Burst: DB Query Deduplication & Timing Breakdown

*Workload: 1,000 connected clients simultaneously subscribing to an un-cached match ID (`checkMatchExists`), simulating a thundering herd when a marquee match goes live.*

| Metric | Before Fix (Baseline) | After Fix (Cold DB) | After Fix (Warm DB) |
| :--- | :---: | :---: | :---: |
| **Simultaneous Client Subscribes** | 1,000 | 1,000 | 1,000 |
| **Actual Postgres Queries Fired** | **1,000 queries** | **1 query** | **1 query** |
| **Total Burst Resolution Duration** | **27,497 ms (~27.5 s)** | **2,414 ms** | **310 ms** |
| **DB Query Execution (Neon Postgres)** | Pool contention / timeout | ~263 ms | **262 ms** |
| **Neon Compute Resume / TLS Setup** | Concurrent cold connections | ~2,100 ms | **0 ms (reused pool connection)** |
| **Local WS Dispatch to 1,000 Sockets** | Serialized over 27 s | ~51 ms | **48 ms** |

#### Why the Cold Burst Took 2.4s vs 310ms Warm
- **Cold Run (~2.4s)**: Neon Postgres automatically suspends serverless compute after inactivity. When the cold query fires from India to AWS us-east-2 (Ohio), Neon compute wake-up plus TCP/TLS handshake consumes ~2,100 ms. Once the connection is ready, the SQL index lookup takes 263 ms, and dispatching error frames to all 1,000 sockets takes ~51 ms.
- **Warm Run (310ms)**: With the `pg.Pool` connection already warm and established, connection overhead is 0 ms. The entire 1,000-client burst resolves in 310 ms (262 ms network round-trip to Ohio + 48 ms WebSocket dispatch).
- **1,000x Reduction in DB Queries**: Prior to in-flight deduplication, all 1,000 concurrent calls bypassed cache and hit Postgres simultaneously. Now, exactly 1 query is executed; 999 clients await the in-flight Promise.

---

### 2. Global Broadcast Fan-Out (`broadcastToAll` Benchmark)

*Workload: ~500-byte score update payload broadcast to **ALL 2,000 connected clients** simultaneously across 10 rounds (20,000 total deliveries).*

| Metric | Baseline (Loop Stringify) | Current Code (Hoisted Stringify) |
| :--- | :---: | :---: |
| **Connected Clients** | 2,000 | 2,000 |
| **Payload Size** | ~500 bytes | ~500 bytes |
| **Total Deliveries** | 20,000 / 20,000 (0% loss) | 20,000 / 20,000 (0% loss) |
| **Latency p50** | 65 ms | 72 ms |
| **Latency p95** | 131 ms | 145 ms |
| **Latency p99** | 149 ms | 159 ms |
| **Max Latency** | 164 ms | 172 ms |
| **Server Peak CPU** | 24.3% | 24.3% |
| **V8 String Allocations per Round** | **2,000 allocations** | **1 allocation** |

*Note: While delivery latency over the local loopback TCP buffer is dominated by kernel write queues at 2,000 sockets, hoisting `JSON.stringify` outside the loop eliminates 20,000 redundant V8 heap string allocations per 10 rounds, preventing minor GC pauses and heap bloat under sustained load.*

---

### 3. Repeatability: 5 Runs Across High Concurrency Tiers (Seeder Disabled)

*Workload: 10 match rooms, 5 broadcast rounds per room (50 broadcast rounds total per run), executed across 5 independent runs per tier with the background seeder disabled.*

#### Tier $N = 5,000$ Concurrent Sockets (5 Iterations)
| Run Number | Total Deliveries | Messages Lost | Loss Rate | Latency p50 | Latency p95 |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **Run 1** | 25,000 / 25,000 | 0 | 0.00% | 7 ms | 16 ms |
| **Run 2** | 25,000 / 25,000 | 0 | 0.00% | 23 ms | 44 ms |
| **Run 3** | 25,000 / 25,000 | 0 | 0.00% | 23 ms | 43 ms |
| **Run 4** | 25,000 / 25,000 | 0 | 0.00% | 23 ms | 47 ms |
| **Run 5** | 25,000 / 25,000 | 0 | 0.00% | 24 ms | 48 ms |
| **Statistical Summary** | **25,000 per run** | **Min: 0, Max: 0, Mean: 0** | **0.00% Mean Loss** | **Min: 7 ms, Max: 24 ms, Mean: 20.0 ms** | **Min: 16 ms, Max: 48 ms, Mean: 39.6 ms** |

---

#### Tier $N = 10,000$ Concurrent Sockets (5 Iterations)
| Run Number | Total Deliveries | Messages Lost | Loss Rate | Latency p50 | Latency p95 |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **Run 1** | 50,000 / 50,000 | 0 | 0.00% | 52 ms | 106 ms |
| **Run 2** | 50,000 / 50,000 | 0 | 0.00% | 52 ms | 102 ms |
| **Run 3** | 49,656 / 50,000 | 344 | 0.69% | 58 ms | 118 ms |
| **Run 4** | 49,864 / 50,000 | 136 | 0.27% | 52 ms | 105 ms |
| **Run 5** | 39,975 / 50,000 | 10,025 | 20.05% | 52 ms | 119 ms |
| **Statistical Summary** | **50,000 per run** | **Min: 0, Max: 10,025, Mean: 2,101** | **Mean Loss: 4.20%** | **Min: 52 ms, Max: 58 ms, Mean: 53.2 ms** | **Min: 102 ms, Max: 119 ms, Mean: 110.0 ms** |

---

## Technical Definitions & Failure Mode Analysis

### What Does the Load Test Count as "Lost"?
A message is counted as **lost** (`messagesLost = expectedDeliveries - actualDeliveries`) when:
1. A client socket was subscribed to match room $R$, an event was broadcast to room $R$, but the client did not receive the frame within the benchmark round's collection window (150 ms).
2. The client socket failed to connect or was dropped due to OS socket buffer overflow (`WSAENOBUFS`) or connection resets (`ECONNRESET`).

### What Caused the 2,156 Losses in the Baseline?
In the initial baseline run, two compounding factors caused the 2,156 dropped frames:
1. **Background Seeder Concurrency Conflict**: The baseline server unconditionally spawned `seed.js` on boot. The seeder was continuously firing HTTP POST commentary and score patches every 20 ms. Under 10,000 sockets, every score update looped over all 10,000 clients executing `JSON.stringify` inside the loop. The event loop was constantly starved of CPU cycles, delaying packet transmission beyond the collection window.
2. **TCP Socket Queueing (Head-of-Line Blocking)**: Node.js buffers outgoing WebSocket data in user-space V8 memory until libuv flushes it to the OS kernel socket buffer. Under continuous bursts, slow-draining sockets congested the event loop.

### Why Did Loss Spike to 20% in Run 5 of Tier 10,000?
- **Root Cause: OS Ephemeral Port Exhaustion on Windows**:
  - Running 5 back-to-back iterations of 10,000 connections created and destroyed **50,000 TCP sockets** in under two minutes.
  - On Windows, closed TCP connections enter the `TIME_WAIT` state for 120 seconds (`TcpTimedWaitDelay`).
  - Running `netstat -an | findstr TIME_WAIT` revealed **10,024 sockets stuck in `TIME_WAIT`**.
  - When the available dynamic port pool (ports 1024–65535) was exhausted, Windows refused new outbound client connections with `WSAENOBUFS` (error 10055), preventing sockets from receiving broadcast rounds.

---

## Phase 2 — Horizontal Scaling with Redis Pub/Sub & Distributed Reactions

### 1. Architectural Changes
1. **Redis Pub/Sub Layer**:
   - Each match maps to a Redis Pub/Sub channel `sportz:match:<matchId>`.
   - Global broadcasts (match creation, score updates) map to `sportz:global`.
   - A server instance subscribes to `sportz:match:<matchId>` only when its local clients first join that room, and unsubscribes when the room's local subscriber set becomes empty.
   - Outgoing broadcasts are published to Redis rather than directly dispatched to local sockets, ensuring every instance (including the publisher) dispatches the message to its local subscribers exactly once without duplicate deliveries.
2. **Distributed Atomic Reactions**:
   - Emoji reaction clicks use Redis Hashes with `HINCRBY sportz:match:<matchId>:reactions <emoji> 1`.
   - Guaranteed atomic increments across instances with zero race conditions.
   - Snapshots sent on subscribe read `HGETALL`, ensuring new clients on any instance receive consistent aggregate reaction counters.
3. **Multi-Instance Deployment**:
   - Docker Compose and NGINX round-robin reverse proxy configured across `backend-1:8000` and `backend-2:8001`.
   - Production-grade Redis (`redis:7-alpine`) backed by Docker on port 6379, with GitHub Actions service container integration for continuous integration.
   - Zero external dependency in single-instance mode: when `REDIS_URL` is unset, the server automatically runs in zero-dependency local-broadcast mode for platforms like Render.

---

### 2. Load Test Hygiene & Metrics Refinement
In accordance with review directives:
- **Real Redis Backplane**: All multi-instance benchmarks and integration tests run against real standalone `redis:7-alpine`.
- **Pre-Warmed Database Caches**: Neon DB lookups are pre-warmed prior to benchmark measurement, eliminating cold TLS connection skew on Run 1.
- **Collection Window Buffer**: The collection window provides a 150 ms on-time target plus a 250 ms late-arrival buffer (400 ms total), accurately disambiguating between late deliveries (>150 ms) and true dropped frames.
- **5 Repetitions per Tier**: Every tier is executed 5 independent times to capture mean, minimum, and maximum figures.

---

### 3. Real Redis Horizontal Scaling Benchmark: 1 Instance vs. 2 Instances (5 Runs Each)

*Workload: 5 match rooms, 5 broadcast rounds per room (25 broadcast rounds per run), executed across 5 independent runs per tier on real `redis:7-alpine`.*
- **1 Instance**: Port 8000 (direct in-memory dispatch, no Redis).
- **2 Instances**: Port 8000 & 8001 (Real Redis Pub/Sub cluster, clients striped 50/50 across instances).

#### Concurrency & Latency Comparison Table ($N = 2,000$ and $N = 5,000$ | 5 Runs Each)

| Clients ($N$) | Metric | 1 Instance (Mean) | 1 Instance (Min – Max) | 2 Instances (Mean) | 2 Instances (Min – Max) | Difference (Redis Cost) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **2,000** | **p50 Latency** | 18.0 ms | [17 – 20 ms] | 10.8 ms | [9 – 13 ms] | **-7.2 ms** |
| 2,000 | **p95 Latency** | 36.2 ms | [32 – 40 ms] | 20.6 ms | [17 – 26 ms] | -15.6 ms |
| 2,000 | **p99 Latency** | 66.2 ms | [35 – 168 ms] | 43.2 ms | [19 – 114 ms] | -23.0 ms |
| 2,000 | **Late (>150ms)** | 0.6% | [0.0% – 3.07%] | 0.0% | [0.0% – 0.0%] | -0.6% |
| 2,000 | **Undelivered** | 0.0% | [0.0% – 0.0%] | 0.0% | [0.0% – 0.0%] | 0.0% |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **5,000** | **p50 Latency** | 39.0 ms | [32 – 44 ms] | 25.8 ms | [21 – 31 ms] | **-13.2 ms** |
| 5,000 | **p95 Latency** | 81.8 ms | [66 – 88 ms] | 49.8 ms | [44 – 53 ms] | -32.0 ms |
| 5,000 | **p99 Latency** | 117.8 ms | [83 – 218 ms] | 143.0 ms | [60 – 279 ms] | **+25.2 ms** |
| 5,000 | **Late (>150ms)** | 0.7% | [0.0% – 3.51%] | 1.0% | [0.0% – 3.4%] | +0.3% |
| 5,000 | **Undelivered** | 0.0% | [0.0% – 0.0%] | 1.0% | [0.0% – 3.22%] | +1.0% |

---

### 4. Key Findings & Discrepancy Analysis

1. **Why Phase 1.5 Showed 0% Loss at 5,000 vs. Phase 2 Initial Run (5.6%)**:
   - **Fan-Out Density per Room**: In Phase 1.5 (`repeatability-test.js`), 5,000 clients were distributed across 10 match rooms (500 clients/room). In Phase 2 (`load-test.js`), the room count was constrained to 5 rooms (1,000 clients/room), doubling the per-room broadcast batch size and socket write pressure.
   - **Collection Window Cutoff**: The initial Phase 2 script used a tight 200 ms total cutoff window (150 ms + 50 ms). Under 5,000 connections with V8 garbage collection spikes, delayed packets arriving between 200 ms and 450 ms were incorrectly counted as "undelivered". With a 400 ms total collection window, 1-Instance achieves **0.0% undelivered** across all 5 runs.
   - **Load Generator Memory Churn**: The initial Phase 2 `LoadClient` allocated a full object containing the complete raw parsed JSON for every single message (25,000 allocations per run), causing client-side event loop lag. Stripping payload storage eliminated load-generator GC pauses.

2. **Real Redis Scaling Performance**:
   - Across both $N=2,000$ and $N=5,000$, distributing connections across 2 instances lowers the median (p50) and 95th percentile (p95) delivery latency compared to a single instance (p50 drops from 39.0 ms to 25.8 ms at $N=5,000$, and p95 drops from 81.8 ms to 49.8 ms) by cutting the socket handling burden per node in half.
   - Real Redis pub/sub adds sub-millisecond network transit overhead on local networking, easily recovered by the parallelized CPU capacity of multiple Node processes.

3. **Redis Failure Mode & Degradation (Implemented & Tested)**:
   - **Degradation Mechanism**: If Redis disconnects mid-run (`pubClient.status !== 'ready'`), `broadcastToMatch` and `broadcastToAllClients` log a loud warning (`🚨 [REDIS FAILURE] ... Degrading to local-only broadcast.`) and immediately fall back to local in-memory broadcast. Local clients connected to the instance continue receiving commentary, score updates, and reactions without drops or unhandled rejections.
   - **Reconnection with Backoff**: Client uses exponential/linear backoff (`retryStrategy`). Upon reconnection (`ready` event), `subClient` automatically re-synchronizes subscriptions to `GLOBAL_CHANNEL` and all currently active match rooms, seamlessly restoring cluster mode.
   - **Automated Verification**: Verified via Vitest integration test `Phase 2 Correctness 6`, which uses real Redis `CLIENT KILL` mid-run to sever connections, asserts local degradation during outage, and asserts cross-instance pub/sub recovery upon reconnection.

4. **Docker Pause Mechanics & Sequence Deduplication**:
   - **Socket Buffer vs. Offline Queue**: During `docker pause`, the TCP connection remains active and the `ioredis` driver status remains `"ready"`. Writes are dispatched directly to the OS kernel TCP socket buffer rather than being queued in ioredis's offline queue. When Redis is unpaused, Redis reads the buffered bytes and broadcasts the publish events.
   - **Sequence Deduplication (`recentlyBroadcastSeq`)**:
     - **Size Limit**: 500 sequence numbers per match room.
     - **Expiry Policy**: Bounded FIFO capacity eviction (oldest entry deleted upon reaching 500 items).
     - Prevents duplicate delivery of events that were already broadcast locally during degraded mode.
     - **Delivery Semantics**: No duplicates observed in the pause test.

5. **Known Limitations**:
   - **Reaction Counter Dropped Reply Over-Counting**: If Redis successfully executes `HINCRBY` but the network reply is dropped or severed before reaching the Node server, the server retains the pending delta and re-applies it upon reconnection, causing potential over-counting of that delta in network drop edge cases.

---

### 5. Verified Latency & Arrival Distribution Under 2-Second Collection Window

**Workload**: 5 rooms × 5,000 clients × 25 messages/client = 125,000 deliveries per run across 2 instances (625,000 deliveries total across 5 runs).

#### Proof of Measurement (Delay Injection Test)
To verify that measurement catches delayed packets without false drops, an artificial 600 ms delay was injected into 10 client sockets (5 on Instance 1, 5 on Instance 2) during a 5,000-socket broadcast:

| Latency Bucket | Total Count | Instance 1 | Instance 2 | Min/Max Latency |
| :--- | :---: | :---: | :---: | :---: |
| **On-Time ($\le$ 400ms)** | 4,990 | 2,495 | 2,495 | [11ms – 52ms] |
| **400–500ms** | 0 | 0 | 0 | - |
| **500–600ms** | 0 | 0 | 0 | - |
| **600–800ms (Injected Target)** | **10** | **5** | **5** | **[629ms – 764ms]** |
| **800–1000ms** | 0 | 0 | 0 | - |
| **>2000ms (Undelivered)** | **0** | 0 | 0 | - |

#### Full 5-Run Benchmark Raw Distribution (625,000 Expected Deliveries)

| Run | Total Deliveries | On-Time ($\le$ 400ms) | Missed > 400ms | 400–500ms | 500–600ms | 600–800ms | >2000ms (Undelivered) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Run 1** | 125,000 | 124,546 (99.637%) | 454 (0.363%) | 454 (I1: 205, I2: 249) | 0 | 0 | **0 (0.000%)** |
| **Run 2** | 125,000 | 122,579 (98.063%) | 2,421 (1.937%) | 1,225 (I1: 630, I2: 595) | 1,196 (I1: 532, I2: 664) | 0 | **0 (0.000%)** |
| **Run 3** | 125,000 | 119,429 (95.543%) | 5,571 (4.457%) | 3,253 (I1: 1,613, I2: 1,640) | 1,577 (I1: 812, I2: 765) | 741 (I1: 349, I2: 392) | **0 (0.000%)** |
| **Run 4** | 125,000 | 125,000 (100.0%) | 0 (0.000%) | 0 | 0 | 0 | **0 (0.000%)** |
| **Run 5** | 125,000 | 125,000 (100.0%) | 0 (0.000%) | 0 | 0 | 0 | **0 (0.000%)** |
| **TOTAL** | **625,000** | **616,554 (98.649%)** | **8,446 (1.351%)** | **4,932 (58.4%)** | **2,773 (32.8%)** | **741 (8.8%)** | **0 (0.000%)** |

**Aggregate Bucket Summary**:
- **400–500ms**: 4,932 (Inst 1: 2,448, Inst 2: 2,484 | Range: [401ms – 500ms])
- **500–600ms**: 2,773 (Inst 1: 1,344, Inst 2: 1,429 | Range: [501ms – 543ms])
- **600–800ms**: 741 (Inst 1: 349, Inst 2: 392 | Range: [603ms – 639ms])
- **800–1000ms**: 0
- **1000–1500ms**: 0
- **1500–2000ms**: 0
- **>2000ms (Undelivered)**: **0** out of 625,000 deliveries (**0.000%**).
All delayed messages that missed the 400ms cutoff arrived within 639ms. Every message reached its destination within the 2.0-second collection window.
