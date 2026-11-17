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

### 1. Launch Backend Server in Benchmark Mode with Forced GC
The benchmark mode flag bypasses external rate limiters (`BENCHMARK_BYPASS_ARCJET=1`) while preserving all internal pub/sub logic, connection states, and broadcast loops. `--expose-gc` allows explicit `global.gc()` execution to measure true retained heap:

```powershell
$env:BENCHMARK_BYPASS_ARCJET="1"
cd sportz-websockets-main
node --expose-gc src/index.js
```

### 2. Execute Load Benchmark Suite
The benchmark script (`sportz-websockets-main/scripts/load-test.js`) runs concurrency scaling, global broadcast fan-out, and cold-start subscribe bursts:

```powershell
node sportz-websockets-main/scripts/load-test.js --tiers 100,500,1000,2000,5000,10000 --rounds 10 --mode all
```

Raw JSON execution logs are stored in [`benchmarks/baseline-raw.json`](./benchmarks/baseline-raw.json).

---

## Phase 1 — Extended Baseline Performance (Current Unchanged Code)

### Benchmark 1: Concurrency Scaling & Breaking Point (Room-Based Fan-Out)

10 rooms ($M=10$), 10 broadcast rounds per room ($100$ broadcast rounds total per tier).

| Concurrency ($N$) | Connected Sockets | Connection Errors | Expected Deliveries | Actual Deliveries | Messages Lost | Loss Rate | Latency p50 | Latency p95 | Latency p99 | Max Latency | Server Peak CPU | Load-Gen CPU | Peak RSS | Peak Heap Used |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **100** | 100 | 0 | 1,000 | 1,000 | 0 | 0.00% | **1 ms** | 2 ms | 2 ms | 3 ms | 3.9% | 1.7% | 105.84 MB | 33.74 MB |
| **500** | 500 | 0 | 5,000 | 5,000 | 0 | 0.00% | **2 ms** | 4 ms | 5 ms | 6 ms | 6.8% | 3.1% | 109.16 MB | 34.59 MB |
| **1,000** | 1,000 | 0 | 10,000 | 10,000 | 0 | 0.00% | **3 ms** | 6 ms | 8 ms | 14 ms | 9.9% | 3.9% | 129.16 MB | 44.53 MB |
| **2,000** | 2,000 | 0 | 20,000 | 20,000 | 0 | 0.00% | **6 ms** | 13 ms | 16 ms | 21 ms | 20.0% | 8.9% | 162.70 MB | 43.91 MB |
| **5,000** | 5,000 | 0 | 50,000 | 50,000 | 0 | 0.00% | **12 ms** | 25 ms | 31 ms | 48 ms | 32.7% | 16.9% | 232.89 MB | 70.77 MB |
| **10,000** | 10,000 | 0 | 100,000 | 97,844 | **2,156** | **2.16%** | **27 ms** | **60 ms** | **78 ms** | 98 ms | 48.7% | 35.3% | 283.04 MB | 85.92 MB |

#### Breaking Point Analysis (Tier $N = 10,000$)
- **Observed Failure Mode**: Message delivery drops (2.16% packet loss; 2,156 undelivered messages out of 100,000) and sharp latency degradation (p95 spiked to 60 ms, p99 to 78 ms).
- **Underlying Cause**:
  1. **Event Loop Lag & Socket Buffer Congestion**: In a single Node.js process with 10,000 active WebSocket connections, high-frequency broadcast bursts saturate the libuv event loop and OS socket write buffers. Sockets that drain slowly experience backpressure drops when subsequent broadcast rounds fire before previous frames are flushed over TCP.
  2. **Combined Machine Load**: Total combined process CPU utilization reached ~84% (Server: 48.7%, Load Generator: 35.3%), leading to scheduling latency between the two processes sharing the 8-core CPU.

---

### Benchmark 2: Global Broadcast Fan-Out (`broadcastToAll` Unoptimized Loop)

Score update payload (~344 bytes) broadcast to **ALL** 2,000 connected clients simultaneously across 10 rounds (20,000 total deliveries). In the baseline code, `JSON.stringify(payload)` is executed repeatedly inside the loop for every single client.

| Metric | Baseline Value (Current Code) |
| :--- | :--- |
| **Connected Clients** | 2,000 |
| **Payload Size** | 344 bytes |
| **Total Deliveries** | 20,000 / 20,000 (0% loss) |
| **Latency p50** | **61 ms** |
| **Latency p95** | **132 ms** |
| **Latency p99** | **176 ms** |
| **Max Latency** | **196 ms** |
| **Server Peak CPU** | **36.9%** |
| **Load-Gen CPU** | **27.8%** |

---

### Benchmark 3: Cold-Start Subscribe Burst (Database Deduplication Baseline)

1,000 connected clients simultaneously subscribe to an un-cached match ID (`checkMatchExists`), simulating a thundering herd when a major match goes live.

| Metric | Baseline Value (Current Code) |
| :--- | :--- |
| **Simultaneous Client Subscribes** | 1,000 |
| **Total DB Queries Fired by `checkMatchExists`** | **1,000 queries** |
| **Burst Duration** | **27,497 ms (~27.5 s)** |
| **Database Failure / Throttling Mode** | Pool connection exhaustion against Neon Postgres; queries queued sequentially over the network. |

---

## Retained Memory Analysis (Forced GC)

Memory was measured using Node.js `global.gc()` to eliminate uncollected garbage:
- **Baseline Idle (0 clients)**: 94.09 MB RSS, 28.17 MB Heap Used
- **After 1,000 clients teardown + GC**: 114.17 MB RSS, 28.31 MB Heap Used
- **Peak at 5,000 clients**: 232.89 MB RSS, 70.77 MB Heap Used
- **Peak at 10,000 clients**: 283.04 MB RSS, 85.92 MB Heap Used
- **After 10,000 clients teardown + GC**: 240.23 MB RSS, 37.14 MB Heap Used

---

## Phase 1.5 — Quick Fixes Before / After Results

### 1. Cold-Start Subscribe Burst (Deduplication Fix Verification)

1,000 clients simultaneously subscribing to an un-cached match ID:

| Metric | Before Fix (Baseline) | After Fix (Phase 1.5) | Improvement / Impact |
| :--- | :---: | :---: | :---: |
| **Simultaneous Subscribes** | 1,000 | 1,000 | Identical load |
| **DB Queries Fired by `checkMatchExists`** | **1,000 queries** | **1 query** | **1,000x reduction (100% deduplicated)** |
| **Thundering Herd Resolution Time** | **27,497 ms** | **2,414 ms** | **11.4x faster resolution** |
| **Database Pool Contention** | Exhausted Neon connection pool | Zero connection pool contention | Completely prevents DB pool saturation |

### 2. Concurrency Scaling Comparison (Decoupled Seeder & Optimized Map Lookups)

| Metric | Baseline ($N=10,000$) | Phase 1.5 ($N=10,000$) | Delta / Effect |
| :--- | :---: | :---: | :---: |
| **Connected Sockets** | 10,000 | 10,000 | Stable |
| **Deliveries** | 97,844 / 100,000 | **100,000 / 100,000** | **Zero packet loss achieved** |
| **Messages Lost** | 2,156 (2.16% loss) | **0 (0.00% loss)** | **Eliminated message drop under burst** |
| **Peak Server RSS** | 283.04 MB | **218.98 MB** | **64.06 MB lower memory footprint** |
| **Peak Server CPU** | 48.7% | **42.7%** | Lower CPU overhead |

