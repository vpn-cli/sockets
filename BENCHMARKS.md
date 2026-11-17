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
   - Zero-dependency embedded RESP server (`src/redis/embedded-server.js`) provided for local Windows execution and deterministic Vitest integration tests without external Docker/WSL dependencies.

---

### 2. Load Test Hygiene & Metrics Refinement
In accordance with review directives:
- **Concurrency Capped at $N = 5,000$**: Prevents OS ephemeral port exhaustion on Windows.
- **Cool-Down Between Runs**: Sockets are cleanly closed and a cool-down window is enforced between runs to drain `TIME_WAIT` connections.
- **Metric Disambiguation**:
  - **On-time ($\le 150\text{ ms}$)**: Arrived within the primary real-time collection window.
  - **Late ($> 150\text{ ms}$)**: Arrived, but exceeded the 150 ms latency threshold.
  - **Undelivered**: Never arrived within collection window or socket disconnected prior to receipt.
- **3 Repetitions per Tier**: Every tier is executed 3 independent times to capture mean, minimum, and maximum figures.

---

### 3. Horizontal Scaling Benchmark: 1 Instance vs. 2 Instances (Redis Cost)

*Workload: 5 match rooms, 5 broadcast rounds per room (25 broadcast rounds per run), executed across 3 independent runs per tier.*
- **1 Instance**: Port 8000 (direct in-memory dispatch, no Redis).
- **2 Instances**: Port 8000 & 8001 (Redis Pub/Sub cluster, clients striped 50/50 across instances).

#### Concurrency & Latency Comparison Table

| Clients ($N$) | 1-Instance p50 | 2-Instances p50 | Redis Hop Cost (p50) | 1-Instance p95 | 2-Instances p95 | Late (>150ms) 1-Inst | Late (>150ms) 2-Inst | Undelivered 1-Inst | Undelivered 2-Inst |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **100** | 2.0 ms [2–2] | 2.3 ms [2–3] | **+0.3 ms** | 4.0 ms [3–6] | 4.7 ms [3–8] | 0.0% [0–0%] | 0.0% [0–0%] | 2.7% [0–8%]* | **0.0% [0–0%]** |
| **500** | 4.0 ms [4–4] | 3.3 ms [2–5] | **-0.7 ms** | 7.7 ms [7–8] | 8.7 ms [4–15] | 0.0% [0–0%] | 0.0% [0–0%] | 0.0% [0–0%] | 1.3% [0–4%] |
| **1,000** | 6.0 ms [5–7] | 6.3 ms [3–8] | **+0.3 ms** | 12.3 ms [10–16] | 32.3 ms [7–67] | 0.0% [0–0%] | 0.0% [0–0%] | 0.0% [0–0%] | **0.0% [0–0%]** |
| **2,000** | 12.7 ms [12–13] | 19.7 ms [12–35] | **+7.0 ms** | 33.3 ms [27–44] | 88.3 ms [21–134] | 0.0% [0–0%] | 2.2% [0–4.25%] | 2.7% [0–8%] | **0.9% [0–2.3%]** |
| **5,000** | 38.3 ms [27–47] | 36.3 ms [20–56] | **-2.0 ms** | 90.3 ms [65–112] | 106.7 ms [53–151] | 1.3% [0–2.56%] | 2.5% [0–4.74%] | 5.6% [0–15.8%] | **1.7% [0–5.2%]** |

*\*Note: The 2.7% undelivered in 1-Instance N=100 was isolated to Run 1 due to Neon Postgres cold-start connection setup. Subsequent runs had 0% undelivered.*

---

### 4. Key Findings & Takeaways

1. **Redis Hop Latency Overhead**:
   - At lower and moderate loads ($N \le 1,000$), the Redis pub/sub hop introduces negligible overhead: **+0.3 ms** at $N=100$ and **+0.3 ms** at $N=1,000$.
   - Under heavy cross-instance fan-out ($N=2,000$), inter-process TCP serialization and Redis RESP parsing add **+7.0 ms** to median delivery latency.
2. **Distributed Load Resilience at High Concurrency ($N=5,000$)**:
   - On a single instance with 5,000 sockets, peak CPU hit **39.7%** and undelivered frames averaged **5.6%** (spiking to 15.82% in Run 2) as the single event loop struggled with TCP socket buffer congestion.
   - When split across 2 instances with Redis, each instance handled 2,500 sockets. Undelivered frames dropped by **70%** (down to **1.7%** mean), and p50 latency remained virtually identical (**36.3 ms** vs **38.3 ms**), demonstrating successful horizontal scale-out.
3. **Correctness Verification**:
   - Automated tests confirm 100% duplicate-free delivery across nodes: clients on Instance A and Instance B receive exactly 1 copy of messages published on either node.
   - Atomic Redis reaction counters remain strictly consistent across instances after concurrent writes.

