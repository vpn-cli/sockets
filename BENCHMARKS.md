# Sportz Performance & Scaling Benchmarks

This document records real, reproducible performance benchmarks and latency measurements for the **Sportz** real-time streaming engine.

All metrics are captured using automated benchmark scripts executing against the live WebSocket server with zero simulated or rounded figures.

---

## Machine & Environment Specifications

- **Operating System**: Windows 11 Home Single Language (Build 10.0.26300, x64)
- **CPU**: AMD Ryzen 7 6800H with Radeon Graphics (8 Physical Cores, 16 Logical Processors @ 3.20 GHz base, boost up to 4.7 GHz)
- **System Memory**: 16.0 GB DDR5 RAM (15.26 GiB visible)
- **Node.js Version**: v24.15.0
- **Network / Clocks**: Single-machine localhost testing (`127.0.0.1`), ensuring zero NTP clock drift between client receiver timestamps and server emission timestamps.

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
The client benchmark script (`sportz-websockets-main/scripts/load-test.js`) opens $N$ concurrent sockets staggered across $M$ match rooms, confirms subscriptions, publishes controlled broadcast events, tracks delivery timing at each client, and samples server memory and CPU metrics:

```powershell
node sportz-websockets-main/scripts/load-test.js --tiers 100,500,1000,2000 --rounds 10
```

Raw JSON execution logs are stored in [`benchmarks/baseline-raw.json`](./benchmarks/baseline-raw.json).

---

## Phase 1 — Baseline Performance (Single Instance, Unoptimized)

### Summary Table

| Concurrency ($N$) | Rooms ($M$) | Connected Sockets | Connection Errors | Expected Deliveries | Actual Deliveries | Messages Lost | Loss Rate | Latency p50 | Latency p95 | Latency p99 | Max Latency | Peak CPU | Peak RSS | Peak Heap Used |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **100** | 10 | 100 | 0 | 1,000 | 1,000 | 0 | 0.00% | **1 ms** | 2 ms | 4 ms | 6 ms | 4.4% | 98.04 MB | 30.74 MB |
| **500** | 10 | 500 | 0 | 5,000 | 5,000 | 0 | 0.00% | **3 ms** | 5 ms | 7 ms | 10 ms | 8.2% | 107.54 MB | 35.89 MB |
| **1,000** | 10 | 1,000 | 0 | 10,000 | 10,000 | 0 | 0.00% | **3 ms** | 6 ms | 8 ms | 10 ms | 10.9% | 129.91 MB | 40.01 MB |
| **2,000** | 10 | 2,000 | 0 | 20,000 | 20,000 | 0 | 0.00% | **6 ms** | 12 ms | 14 ms | 17 ms | 17.6% | 113.38 MB | 38.75 MB |

---

## Key Performance Insights (Phase 1 Baseline)

1. **Sub-10ms Fan-out Latency at $N \le 1,000$**:
   - At 100 concurrent sockets, median broadcast latency is **1 ms**, with p99 at **4 ms**.
   - At 1,000 concurrent sockets, median latency remains **3 ms**, with p99 reaching **8 ms**.
2. **Latency Scaling under 2,000 Concurrency**:
   - At 2,000 concurrent connections across 10 rooms (200 clients receiving per broadcast event), p50 latency climbs to **6 ms**, p95 to **12 ms**, and p99 to **14 ms**.
   - Maximum observed latency was **17 ms**, well within the 50ms real-time sports broadcast SLA.
3. **Reliability & Message Loss**:
   - Across all 4 tiers (totaling 36,000 message deliveries), **zero messages were lost** (0.00% drop rate).
   - Zero connection dropouts or socket handshake errors occurred under staggered connection ramp-up.
4. **Memory Footprint**:
   - Baseline server RSS idle footprint is ~93.6 MB (including Node.js V8 runtime, Neon pg connection pool, and Express router).
   - Under 1,000 active WebSocket connections, RSS memory climbed to **129.9 MB**, representing ~36.3 KB per active connection state.
5. **Event Loop & CPU Pressure**:
   - CPU utilization scaled linearly from 4.4% at $N=100$ to **17.6%** at $N=2000$ during active broadcast rounds.
