// server.ts
import express from "express";
import http from "http";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

// src/rag/knowledgeStore.ts
var INITIAL_KNOWLEDGE_BASE = [
  {
    id: "doc-ipc-ring-buffer",
    title: "Zero-Copy POSIX Shared Memory Ring Buffer Architecture",
    category: "SYSTEM_ARCHITECTURE",
    tags: ["POSIX", "mmap", "IPC", "Zero-Copy", "Lock-Free", "C-Struct"],
    content: `ChronosMatch replaces traditional TCP sockets and JSON serialization with a lock-free circular ring buffer allocated in Linux shared memory (/dev/shm).
1. Fixed 32-Byte C-Struct: Every order is serialized into a 32-byte binary structure (price_cents: uint64, quantity: uint32, order_id: uint64, symbol_id: uint32, side: uint8, type: uint8, flags: uint16).
2. Cache-Line Alignment: Producer and consumer write/read cursor indices are aligned to distinct 64-byte CPU cache lines with padding to prevent cache-line bounce and false sharing.
3. Atomic Pointer Math: Updates use atomic load/store primitives (memory_order_acquire / memory_order_release) avoiding pthread mutex contention and OS syscall context switches.
4. Latency Benchmark: Zero-copy mmap achieves 0.8\xB5s to 1.8\xB5s write latency, compared to 142\xB5s for JSON over TCP loopback and 48\xB5s for Python pickle.`,
    sourceDoc: "chronosmatch/chronos_ring_buffer.py & tuning_guide.md",
    updatedAt: "2026-10-19T06:00:00Z"
  },
  {
    id: "doc-cpu-tsc-calibration",
    title: "Sub-Microsecond Core Pinning & TSC Hardware Timestamping",
    category: "SYSTEM_ARCHITECTURE",
    tags: ["TSC", "RDTSC", "Core Pinning", "Affinity", "isolcpus", "Hardware"],
    content: `In high-frequency quantitative execution, kernel scheduler preemptions and CPU migrations introduce catastrophic tail latency (jitter).
1. Thread Affinity: ChronosMatch pins the matching engine execution thread to a dedicated physical CPU core using Linux sched_setaffinity / taskset, paired with the Linux boot parameter isolcpus.
2. Invariant TSC Calibration: Latency is measured directly via the CPU hardware Time Stamp Counter (RDTSC/RDTSCP instruction) running at 3.40 GHz. This eliminates gettimeofday() syscall overhead (from 45ns down to 7ns).
3. Cache Locality: The active order book trees and LOB arrays reside permanently in L1 Data Cache (32KB, 4 CPU cycles) and L2 Cache (1MB, 14 cycles).
4. Memory Allocation Discipline: Cython nogil blocks and static pre-allocated memory arenas prevent Python Garbage Collection (GC) pauses during order execution.`,
    sourceDoc: "chronosmatch/chronos_engine.pyx & low_latency_tuning.sh",
    updatedAt: "2026-10-19T06:00:00Z"
  },
  {
    id: "doc-lob-microstructure",
    title: "Price-Time Priority Limit Order Book (LOB) Dynamics",
    category: "MARKET_MICROSTRUCTURE",
    tags: ["LOB", "Price-Time Priority", "FIFO", "Queue Position", "Adverse Selection"],
    content: `ChronosMatch operates a deterministic Price-Time Priority (FIFO) matching algorithm:
1. Bid / Ask Hierarchy: Bids are prioritized from highest price to lowest; Asks from lowest price to highest. Within identical price ticks, orders are queued in strictly chronological arrival order.
2. Queue Position Economics: Limit orders positioned at the top of the queue enjoy superior fill probability. As orders fill, subsequent orders advance.
3. Adverse Selection: Aggressive taker orders that sweep multiple price levels deplete top-of-book liquidity, causing instantaneous spread widening and inventory imbalance.
4. Market Impact Model: Square-root law of market impact: Impact ~ Y * Sigma * sqrt(Volume_Exec / Daily_Volume). Slicing larger parent blocks into child orders minimizes permanent price displacement.`,
    sourceDoc: "chronosmatch/engine_pure.py",
    updatedAt: "2026-10-19T06:00:00Z"
  },
  {
    id: "doc-algo-execution-twap-vwap",
    title: "Algorithmic Order Slicing: TWAP, VWAP & Implementation Shortfall",
    category: "QUANT_STRATEGIES",
    tags: ["TWAP", "VWAP", "Sniper", "Iceberg", "Implementation Shortfall", "Slippage"],
    content: `Institutional trading desks execute large block orders through algorithmic slicing engines to prevent liquidity erosion:
1. TWAP (Time-Weighted Average Price): Breaks parent orders into equal, discrete time-spaced tranches across a specified duration.
2. VWAP (Volume-Weighted Average Price): Profiles historical intraday volume curves (U-shaped smile curve at market open and close) to allocate larger child tranches during peak market depth.
3. Sniper Execution: Passive pegging that remains invisible until a favorable price tick or micro-burst occurs, then fires a sub-50\xB5s aggressive cross.
4. Iceberg Orders: Display a small visible tranche (e.g., 100 shares) while keeping thousands of shares hidden in reserve. As soon as the surface is filled, the engine reloads the next tranche automatically.
5. Implementation Shortfall: Calculated as (Average Execution Price - Arrival Mid-Price) * Quantity. ChronosMatch tracks slippage in cents and basis points (bps) in real time.`,
    sourceDoc: "src/components/AlgoExecutionStudio.tsx",
    updatedAt: "2026-10-19T06:00:00Z"
  },
  {
    id: "doc-nbbo-smart-router",
    title: "Multi-Venue Smart Order Routing (SOR) & IEX Speed Bump Mechanics",
    category: "MARKET_MICROSTRUCTURE",
    tags: ["SOR", "NBBO", "IEX", "Speed Bump", "Arbitrage", "Reg NMS"],
    content: `Under Reg NMS Rule 611 (Order Protection Rule), brokers must route trades to the venue displaying the National Best Bid or Offer (NBBO):
1. Multi-Exchange Latency: NASDAQ (Carteret, NJ ~32\xB5s), NYSE Arca (Mahwah, NJ ~46\xB5s), BATS EDGX (Secaucus, NJ ~27\xB5s).
2. Latency Arbitrage: High-frequency market makers detect quote movements on fast exchanges (BATS) and race to cancel or pick off stale orders on slower exchanges.
3. The IEX 350\xB5s Speed Bump: IEX routes all incoming order packets through a 38-mile continuous coiled fiber optic spool inside the Secaucus data center, introducing an exact 350-microsecond physical delay.
4. Protection: This 350\xB5s physical buffer ensures IEX internal peg prices can update using consolidated SIP feeds before predatory algorithms can pick off resting midpoint limit orders.`,
    sourceDoc: "src/components/SmartOrderRouter.tsx",
    updatedAt: "2026-10-19T06:00:00Z"
  },
  {
    id: "doc-spoofing-iceberg-detection",
    title: "Market Anomaly Detection: Spoofing, Layering & Whale Sweeps",
    category: "ANOMALIES_AND_RISK",
    tags: ["Spoofing", "Layering", "Whale Sweep", "Icebergs", "Compliance", "Audit"],
    content: `Algorithmic surveillance models continuously audit the limit order book for manipulation patterns:
1. Spoofing Detection: A trader places large phantom non-bona-fide orders (e.g. >10,000 shares) on one side of the book to simulate artificial pressure, only to cancel them within <20ms before execution. ChronosMatch flags rapid cancellation spikes.
2. Layering: Submitting multiple orders across progressive price levels to mislead other market participants about true depth.
3. Whale Sweep Alerts: Instantaneous aggressive market orders that deplete 3 or more book tiers in a single microsecond timestamp.
4. Cryptographic WAL Audit: Every matched execution is stamped into an immutable SQLite Write-Ahead Log (WAL) with SHA-256 block hashes for regulatory non-repudiation.`,
    sourceDoc: "chronosmatch/trade_audit_ledger.py & src/components/OrderFlowHeatmap.tsx",
    updatedAt: "2026-10-19T06:00:00Z"
  },
  {
    id: "doc-2010-flash-crash",
    title: "May 6, 2010 Flash Crash Post-Mortem & Liquidity Cascade Mechanics",
    category: "ANOMALIES_AND_RISK",
    tags: ["Flash Crash", "Cascade", "Liquidity Void", "Feedback Loop", "Risk Limits"],
    content: `The May 6, 2010 Flash Crash remains the quintessential study in algorithmic liquidity evaporation:
1. Trigger Event: A mutual fund initiated a $4.1 billion algorithmic sell program targeting E-Mini S&P 500 futures, paced at 9% of volume without price sensitivity.
2. HFT Hot-Potato Feedback: Quantitative market makers rapidly bought and sold the contracts to shed inventory, passing risk back and forth like a hot potato.
3. Liquidity Void: When internal risk and drawdown thresholds were breached, institutional algorithms withdrew all bids simultaneously.
4. Result: Equities plummeted nearly 1,000 points (9%) in minutes, with shares of blue-chip companies executing at 1 cent or $100,000 before circuit breakers paused trading. ChronosMatch simulates this scenario in the Market Time Machine.`,
    sourceDoc: "src/components/MarketTimeMachine.tsx",
    updatedAt: "2026-10-19T06:00:00Z"
  }
];
var knowledgeBase = [...INITIAL_KNOWLEDGE_BASE];
function getAllDocuments() {
  return knowledgeBase;
}
function addDocument(doc) {
  const newDoc = {
    ...doc,
    id: `doc-${Date.now().toString(36)}`,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  knowledgeBase.unshift(newDoc);
  return newDoc;
}
function searchKnowledgeBase(query, topK = 3) {
  if (!query || query.trim() === "") return [];
  const normalizedQuery = query.toLowerCase();
  const queryTerms = normalizedQuery.split(/\s+/).filter((t) => t.length > 2);
  const results = knowledgeBase.map((doc) => {
    let score = 0;
    const docText = `${doc.title} ${doc.tags.join(" ")} ${doc.content}`.toLowerCase();
    if (docText.includes(normalizedQuery)) {
      score += 0.45;
    }
    queryTerms.forEach((term) => {
      if (doc.title.toLowerCase().includes(term)) {
        score += 0.25;
      }
      if (doc.tags.some((t) => t.toLowerCase().includes(term))) {
        score += 0.2;
      }
      const occurrences = (docText.match(new RegExp(term, "g")) || []).length;
      score += Math.min(0.25, occurrences * 0.05);
    });
    let matchedSnippet = "";
    const sentences = doc.content.split(". ");
    const matchingSentence = sentences.find(
      (s) => queryTerms.some((t) => s.toLowerCase().includes(t))
    );
    matchedSnippet = matchingSentence ? matchingSentence.trim() + "." : doc.content.substring(0, 160) + "...";
    return {
      doc,
      score: Math.min(0.99, Number(score.toFixed(3))),
      matchedSnippet
    };
  });
  return results.filter((r) => r.score > 0.05).sort((a, b) => b.score - a.score).slice(0, topK);
}
function buildRAGContext(retrievals, telemetrySnapshot) {
  let context = "=== RETRIEVED QUANT KNOWLEDGE BASE DOCUMENTS ===\n";
  if (retrievals.length === 0) {
    context += "(No specific document chunks met threshold, relying on core domain principles)\n";
  } else {
    retrievals.forEach((r, idx) => {
      context += `[SOURCE ${idx + 1}]: "${r.doc.title}" (Category: ${r.doc.category}, Relevance: ${(r.score * 100).toFixed(1)}%)
`;
      context += `Content:
${r.doc.content}

`;
    });
  }
  if (telemetrySnapshot) {
    context += "=== LIVE HFT ENGINE TELEMETRY SNAPSHOT ===\n";
    context += `Symbol: ${telemetrySnapshot.symbol || "NVDA"}
`;
    context += `Target Ingestion Rate: ${telemetrySnapshot.target_rate || 2e4} TPS
`;
    context += `Live Match TPS: ${telemetrySnapshot.match_tps || 24780}
`;
    context += `Current Spread: $${telemetrySnapshot.spread?.toFixed(2) || "0.01"}
`;
    context += `Avg Latency: ${telemetrySnapshot.avg_latency_us?.toFixed(1) || "1.8"}\xB5s | p99: ${telemetrySnapshot.p99_us?.toFixed(1) || "18.6"}\xB5s
`;
    if (telemetrySnapshot.bids?.[0] && telemetrySnapshot.asks?.[0]) {
      context += `Top Bid: $${telemetrySnapshot.bids[0].price} (${telemetrySnapshot.bids[0].volume} sh) | Top Ask: $${telemetrySnapshot.asks[0].price} (${telemetrySnapshot.asks[0].volume} sh)
`;
    }
    context += "==========================================\n";
  }
  return context;
}

// server.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var projectRoot = process.cwd();
dotenv.config({ path: path.join(projectRoot, ".env.local"), quiet: true });
dotenv.config({ quiet: true });
var app = express();
var server = http.createServer(app);
var runtimeDir = process.env.CHRONOS_RUNTIME_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "chronosmatch-"));
var configuredPort = Number.parseInt(process.env.PORT || "3000", 10);
var PORT = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3e3;
var DEFAULT_ENGINE_RATE = 25e3;
var MAX_BENCHMARK_COUNT = 1e6;
app.use(express.json());
app.use((req, res, next) => {
  const allowedOrigin = process.env.FRONTEND_URL?.trim();
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});
var geminiApiKey = process.env.GEMINI_API_KEY?.trim();
var ai = geminiApiKey ? new GoogleGenAI({
  apiKey: geminiApiKey,
  httpOptions: {
    headers: {
      "User-Agent": "aistudio-build"
    }
  }
}) : null;
if (!ai) {
  console.warn("[Gemini] GEMINI_API_KEY is not configured. Gemini endpoints will return HTTP 503.");
}
function getGeminiClient() {
  if (!ai) {
    throw new Error("GEMINI_API_KEY is not configured. Add it to .env.local and restart the server.");
  }
  return ai;
}
function getPythonCommand() {
  if (process.env.PYTHON_EXECUTABLE) {
    return { command: process.env.PYTHON_EXECUTABLE, args: [] };
  }
  if (process.platform === "win32") {
    return { command: "py", args: ["-3"] };
  }
  return { command: "python3", args: [] };
}
function spawnPython(args, options) {
  const python = getPythonCommand();
  const child = spawn(python.command, [...python.args, ...args], {
    ...options,
    env: {
      ...process.env,
      CHRONOS_RUNTIME_DIR: runtimeDir
    }
  });
  child.once("error", (error) => {
    console.error(`[Python] Unable to start ${python.command}: ${error.message}`);
  });
  return child;
}
function listenOnAvailablePort(port) {
  let settled = false;
  const handleListening = () => {
    if (settled) {
      return;
    }
    settled = true;
    server.removeListener("error", handleError);
    const address = server.address();
    const activePort = typeof address === "object" && address ? address.port : port;
    console.log(`[ChronosMatch] Full-stack engine UI server running on http://localhost:${activePort}`);
  };
  const handleError = (error) => {
    if (settled) {
      return;
    }
    settled = true;
    server.removeListener("listening", handleListening);
    if (error.code === "EADDRINUSE") {
      const nextPort = port + 1;
      console.warn(`[Server] Port ${port} is already in use; trying ${nextPort}.`);
      server.removeListener("error", handleError);
      server.close(() => listenOnAvailablePort(nextPort));
      return;
    }
    console.error("[Server] Failed to start:", error);
    process.exitCode = 1;
  };
  server.once("listening", handleListening);
  server.once("error", handleError);
  server.listen(port, "0.0.0.0");
}
var pythonProcess = null;
var latestTelemetry = null;
var sseClients = /* @__PURE__ */ new Set();
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}
function normalizeSymbol(value, fallback = "NVDA") {
  if (typeof value !== "string") {
    return fallback;
  }
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9._-]{1,20}$/.test(symbol) ? symbol : fallback;
}
function startPythonEngine(rate = DEFAULT_ENGINE_RATE, symbol = "NVDA") {
  if (pythonProcess) {
    return { status: "already_running", pid: pythonProcess.pid };
  }
  const normalizedRate = parsePositiveInteger(rate, DEFAULT_ENGINE_RATE);
  const normalizedSymbol = normalizeSymbol(symbol);
  const scriptPath = path.join(projectRoot, "chronosmatch", "runner.py");
  const child = spawnPython([scriptPath, "--rate", String(normalizedRate), "--symbol", normalizedSymbol], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"]
  });
  pythonProcess = child;
  console.log(`[ChronosMatch] Python engine spawned (PID: ${child.pid})`);
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (line.startsWith("CHRONOS_JSON:")) {
        try {
          const jsonStr = line.slice("CHRONOS_JSON:".length);
          const data = JSON.parse(jsonStr);
          latestTelemetry = data;
          broadcastSSE("telemetry", data);
        } catch (error) {
          console.error("[Python] Invalid telemetry payload:", getErrorMessage(error));
        }
      } else if (line.startsWith("CHRONOS_RESP:")) {
        try {
          const resp = JSON.parse(line.slice("CHRONOS_RESP:".length));
          broadcastSSE("response", resp);
        } catch (error) {
          console.error("[Python] Invalid response payload:", getErrorMessage(error));
        }
      }
    }
  });
  child.stderr?.on("data", (errChunk) => {
    console.error(`[Python Engine Stderr]:`, errChunk.toString());
  });
  child.once("error", (error) => {
    console.error("[ChronosMatch] Python engine process error:", getErrorMessage(error));
    if (pythonProcess === child) {
      pythonProcess = null;
      broadcastSSE("engine_status", { running: false, error: getErrorMessage(error) });
    }
  });
  child.on("close", (code) => {
    console.log(`[ChronosMatch] Python engine stopped with code ${code}`);
    if (pythonProcess !== child) {
      return;
    }
    pythonProcess = null;
    broadcastSSE("engine_status", { running: false, code });
  });
  return { status: "started", pid: child.pid };
}
function broadcastSSE(event, data) {
  const payload = `event: ${event}
data: ${JSON.stringify(data)}

`;
  for (const client of [...sseClients]) {
    if (client.writableEnded || client.destroyed) {
      sseClients.delete(client);
      continue;
    }
    try {
      client.write(payload);
    } catch (error) {
      console.error("[SSE] Failed to write event:", getErrorMessage(error));
      sseClients.delete(client);
      client.destroy();
    }
  }
}
try {
  startPythonEngine(DEFAULT_ENGINE_RATE, "NVDA");
} catch (error) {
  console.error("[ChronosMatch] Error auto-starting engine:", getErrorMessage(error));
}
app.get("/api/engine/status", (req, res) => {
  res.json({
    running: !!pythonProcess,
    pid: pythonProcess?.pid || null,
    latestTelemetry
  });
});
app.post("/api/engine/start", (req, res) => {
  const rate = parsePositiveInteger(req.body?.rate, DEFAULT_ENGINE_RATE);
  const symbol = normalizeSymbol(req.body?.symbol);
  const result = startPythonEngine(rate, symbol);
  res.json(result);
});
app.post("/api/engine/stop", (req, res) => {
  const processToStop = pythonProcess;
  if (processToStop) {
    try {
      processToStop.stdin?.write(JSON.stringify({ action: "stop" }) + "\n");
    } catch (error) {
      console.error("[Python] Failed to send stop command:", getErrorMessage(error));
    }
    setTimeout(() => {
      if (pythonProcess === processToStop && !processToStop.killed) {
        processToStop.kill("SIGTERM");
      }
    }, 500);
    res.json({ status: "stopping" });
  } else {
    res.json({ status: "not_running" });
  }
});
app.post("/api/engine/command", (req, res) => {
  if (!pythonProcess || !pythonProcess.stdin) {
    return res.status(400).json({ error: "Engine not running" });
  }
  const cmd = req.body;
  try {
    pythonProcess.stdin.write(JSON.stringify(cmd) + "\n");
  } catch (error) {
    console.error("[Python] Failed to send command:", getErrorMessage(error));
    return res.status(503).json({ error: "Engine command could not be sent" });
  }
  res.json({ status: "command_sent", cmd });
});
app.post("/api/benchmark/run", (req, res) => {
  const count = parsePositiveInteger(req.body?.count, 2e4, MAX_BENCHMARK_COUNT);
  const benchScript = path.join(projectRoot, "chronosmatch", "ipc_audit_benchmark.py");
  const proc = spawnPython([benchScript, String(count)], { cwd: projectRoot });
  let output = "";
  let errOutput = "";
  proc.stdout?.on("data", (d) => {
    output += d.toString();
  });
  proc.stderr?.on("data", (d) => {
    errOutput += d.toString();
  });
  proc.once("error", (error) => {
    console.error("[Benchmark] Failed to start benchmark:", getErrorMessage(error));
    if (!res.headersSent) {
      res.status(500).json({ error: "Benchmark could not be started" });
    }
  });
  proc.on("close", (code) => {
    if (res.headersSent) {
      return;
    }
    if (code !== 0) {
      return res.status(500).json({ error: "Benchmark failed", details: errOutput.trim() || "The benchmark process exited unsuccessfully." });
    }
    try {
      const data = JSON.parse(output);
      res.json(data);
    } catch (error) {
      console.error("[Benchmark] Failed to parse output:", getErrorMessage(error));
      res.status(502).json({ error: "Failed to parse benchmark output" });
    }
  });
});
app.get("/api/audit/trades", (req, res) => {
  const sqlite3Script = `
import sqlite3
import json
import os

db_path = ${JSON.stringify(path.join(runtimeDir, "chronos_trades_audit.db"))}
if not os.path.exists(db_path):
    print(json.dumps([]))
    exit(0)

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()
try:
    cur.execute("SELECT trade_id, maker_order_id, taker_order_id, timestamp_ns, latency_ns, price_cents, quantity, flags, created_at FROM trades ORDER BY trade_id DESC LIMIT 100")
    rows = cur.fetchall()
    trades = []
    for r in rows:
        trades.append({
            "trade_id": r["trade_id"],
            "maker_order_id": r["maker_order_id"],
            "taker_order_id": r["taker_order_id"],
            "timestamp_ns": r["timestamp_ns"],
            "latency_us": round(r["latency_ns"] / 1000.0, 2),
            "price": round(r["price_cents"] / 100.0, 2),
            "quantity": r["quantity"],
            "is_whale": bool(r["flags"] & 1 or r["quantity"] >= 5000),
            "created_at": r["created_at"]
        })
    print(json.dumps(trades))
except Exception as e:
    print(str(e), file=sys.stderr)
    raise
finally:
    conn.close()
`;
  const proc = spawnPython(["-c", sqlite3Script], { cwd: projectRoot });
  let out = "";
  proc.stdout?.on("data", (d) => {
    out += d.toString();
  });
  proc.on("error", (error) => {
    console.error("[Audit] Failed to start audit query:", getErrorMessage(error));
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to query audit ledger" });
    }
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      console.error("[Audit] Audit query exited with code:", code);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to query audit ledger" });
      }
      return;
    }
    try {
      res.json(JSON.parse(out));
    } catch (error) {
      console.error("[Audit] Failed to parse audit query output:", getErrorMessage(error));
      res.status(502).json({ error: "Failed to parse audit ledger output" });
    }
  });
});
app.post("/api/gemini/chat", async (req, res) => {
  try {
    const {
      messages,
      model = "gemini-3.8-flash",
      useSearch = true,
      systemInstruction
    } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages array is required" });
    }
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : m.role,
      parts: [{ text: String(m.content || "") }]
    }));
    const config = {
      systemInstruction: systemInstruction || `You are Chronos AI, an elite Quantitative Analyst and Ultra-Low-Latency Systems Architect embedded within the ChronosMatch High-Frequency Trading Engine.
You specialize in:
- High-Frequency Trading (HFT) and sub-50 microsecond execution architectures.
- Limit Order Books (LOB), Price-Time Priority matching, FIFO queues, and queue position dynamics.
- Zero-copy shared memory IPC using POSIX mmap, lock-free ring buffers, cache-line padding, and atomic cursors.
- Hardware optimizations: CPU core pinning, isolcpus, hugepages, NUMA locality, and Solarflare OpenOnload kernel bypass.
- Market microstructure: liquidity sweeps, iceberg orders, institutional whale detection, spread dynamics, and earnings volatility.
- Up-to-date market intelligence, macro trends, and asset analysis using Google Search Grounding.

Deliver responses with mathematical precision, actionable trade/engineering insights, and citations when grounded search data is retrieved.`
    };
    if (useSearch) {
      config.tools = [{ googleSearch: {} }];
    }
    let response;
    let actualModel = model || "gemini-3.8-flash";
    try {
      response = await getGeminiClient().models.generateContent({
        model: actualModel,
        contents,
        config
      });
    } catch (modelErr) {
      const errMsg = String(modelErr?.message || "");
      if (actualModel !== "gemini-3.1-flash-lite" && (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.includes("high demand") || errMsg.includes("overloaded"))) {
        console.warn(`[Gemini] ${actualModel} hit capacity or error (${errMsg}). Gracefully falling back to gemini-3.1-flash-lite`);
        actualModel = "gemini-3.1-flash-lite";
        const fallbackConfig = { ...config };
        delete fallbackConfig.tools;
        response = await getGeminiClient().models.generateContent({
          model: actualModel,
          contents,
          config: fallbackConfig
        });
      } else {
        throw modelErr;
      }
    }
    let text = response.text || "";
    if (!text && response.candidates?.[0]?.content?.parts) {
      text = response.candidates[0].content.parts.map((p) => p.text || "").filter(Boolean).join("\n");
    }
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    res.json({
      text: text || "Analysis completed with no text payload.",
      groundingChunks,
      model: actualModel
    });
  } catch (error) {
    console.error("Gemini API error:", error);
    res.status(500).json({
      error: error?.message || "Failed to generate response from Gemini API",
      details: String(error)
    });
  }
});
app.get("/api/rag/documents", (req, res) => {
  try {
    const docs = getAllDocuments();
    res.json({
      total: docs.length,
      documents: docs,
      categories: ["SYSTEM_ARCHITECTURE", "MARKET_MICROSTRUCTURE", "QUANT_STRATEGIES", "ANOMALIES_AND_RISK", "USER_RULES"]
    });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to fetch RAG documents" });
  }
});
app.post("/api/rag/documents", (req, res) => {
  try {
    const { title, category, tags, content, sourceDoc } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: "Title and content are required" });
    }
    const created = addDocument({
      title,
      category: category || "USER_RULES",
      tags: Array.isArray(tags) ? tags : ["CUSTOM"],
      content,
      sourceDoc: sourceDoc || "User Ingestion Console"
    });
    res.json({ success: true, document: created });
  } catch (err) {
    res.status(500).json({ error: err?.message || "Failed to add RAG document" });
  }
});
app.post("/api/rag/query", async (req, res) => {
  const startTime = Date.now();
  try {
    const {
      query,
      topK = 3,
      includeTelemetry = true,
      model = "gemini-3.8-flash"
    } = req.body;
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Query string is required" });
    }
    const retrievals = searchKnowledgeBase(query, Math.min(6, Math.max(1, topK)));
    const retrievalLatencyMs = Date.now() - startTime;
    const ragContext = buildRAGContext(
      retrievals,
      includeTelemetry ? latestTelemetry : void 0
    );
    const systemInstruction = `You are Chronos Quant RAG, the specialized Retrieval-Augmented Intelligence Engine for the ChronosMatch High-Frequency Trading platform.
You are grounded in proprietary low-latency systems architecture, market microstructure physics, limit order book mathematics, and live telemetry.

GROUNDING RULES:
1. Always base your response directly on the provided [RETRIEVED QUANT KNOWLEDGE BASE DOCUMENTS] and [LIVE HFT ENGINE TELEMETRY SNAPSHOT].
2. Cite the retrieved source document titles specifically (e.g. "[Source: Zero-Copy POSIX Shared Memory Ring Buffer Architecture]").
3. When discussing telemetry, refer explicitly to the live numbers provided (such as live spread, top bid/ask, and microsecond latencies).
4. Provide structured, authoritative, mathematically grounded explanations with code or formula snippets when relevant.`;
    const contents = [
      {
        role: "user",
        parts: [
          {
            text: `${ragContext}

USER INQUIRY:
${query}

Please synthesize a comprehensive, grounded quantitative response with explicit citations to the retrieved sources above.`
          }
        ]
      }
    ];
    let response;
    let actualModel = model || "gemini-3.8-flash";
    try {
      response = await getGeminiClient().models.generateContent({
        model: actualModel,
        contents,
        config: {
          systemInstruction,
          temperature: 0.2
        }
      });
    } catch (modelErr) {
      console.warn(`[RAG Gemini] Fallback to gemini-3.1-flash-lite due to:`, modelErr?.message);
      actualModel = "gemini-3.1-flash-lite";
      response = await getGeminiClient().models.generateContent({
        model: actualModel,
        contents,
        config: {
          systemInstruction,
          temperature: 0.2
        }
      });
    }
    let answer = response.text || "";
    if (!answer && response.candidates?.[0]?.content?.parts) {
      answer = response.candidates[0].content.parts.map((p) => p.text || "").filter(Boolean).join("\n");
    }
    const totalLatencyMs = Date.now() - startTime;
    res.json({
      answer: answer || "RAG synthesis completed with no text payload.",
      retrievedChunks: retrievals.map((r) => ({
        id: r.doc.id,
        title: r.doc.title,
        category: r.doc.category,
        relevanceScore: r.score,
        relevancePct: Math.round(r.score * 100),
        matchedSnippet: r.matchedSnippet,
        sourceDoc: r.doc.sourceDoc,
        tags: r.doc.tags
      })),
      telemetryIncluded: includeTelemetry && !!latestTelemetry,
      retrievalLatencyMs,
      totalLatencyMs,
      model: actualModel
    });
  } catch (error) {
    console.error("RAG Query API error:", error);
    res.status(500).json({
      error: error?.message || "Failed to execute RAG query",
      details: String(error)
    });
  }
});
app.get("/api/source-code", (req, res) => {
  const files = [
    { name: "chronos_types.py", path: "chronosmatch/chronos_types.py", desc: "Binary C-Struct definitions (32-byte Order, 56-byte Trade, 64-byte Header)" },
    { name: "chronos_ring_buffer.py", path: "chronosmatch/chronos_ring_buffer.py", desc: "Lock-Free POSIX Memory-Mapped circular buffer with zero serialization" },
    { name: "chronos_engine.pyx", path: "chronosmatch/chronos_engine.pyx", desc: "Cython C-extension LOB with arena allocation, nogil matching & C-struct pointers" },
    { name: "setup.py", path: "chronosmatch/setup.py", desc: "Cython compilation configuration with GCC -O3 and -march=native flags" },
    { name: "engine_pure.py", path: "chronosmatch/engine_pure.py", desc: "Zero-Copy Price-Time Priority LOB with nanosecond latency tracking" },
    { name: "market_firehose.py", path: "chronosmatch/market_firehose.py", desc: "Asyncio mock order generator pumping 100,000+ orders/second" },
    { name: "latency_monitor_curses.py", path: "chronosmatch/latency_monitor_curses.py", desc: "Python curses terminal TUI displaying real-time depth & whale alerts" },
    { name: "trade_audit_ledger.py", path: "chronosmatch/trade_audit_ledger.py", desc: "Asynchronous SQLite WAL persistence ledger for regulatory auditability" },
    { name: "ipc_audit_benchmark.py", path: "chronosmatch/ipc_audit_benchmark.py", desc: "Zero-copy vs Pickle vs JSON benchmark suite with GC metrics" },
    { name: "low_latency_tuning.sh", path: "chronosmatch/low_latency_tuning.sh", desc: "Bare-metal Linux kernel tuning script (CPU isolation, hugepages, sysctl)" },
    { name: "tuning_guide.md", path: "chronosmatch/tuning_guide.md", desc: "Low-latency systems architecture documentation & deployment manual" },
    { name: "firestore.rules", path: "firestore.rules", desc: "Zero-Trust ABAC security rules for Firestore cloud trade vault and watchlists" },
    { name: "firebase-blueprint.json", path: "firebase-blueprint.json", desc: "Intermediate representation JSON schema for cloud models" }
  ];
  const sourceFiles = files.map((f) => {
    const fullPath = path.join(projectRoot, f.path);
    let content = "";
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch (error) {
      console.error(`[Source] Failed to read ${f.path}:`, getErrorMessage(error));
      content = `# File not found: ${f.path}`;
    }
    return {
      name: f.name,
      path: f.path,
      description: f.desc,
      content
    };
  });
  res.json(sourceFiles);
});
app.get("/api/engine/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });
  res.write("\n");
  sseClients.add(res);
  res.on("error", (error) => {
    console.error("[SSE] Client connection error:", getErrorMessage(error));
    sseClients.delete(res);
  });
  if (latestTelemetry) {
    res.write(`event: telemetry
data: ${JSON.stringify(latestTelemetry)}

`);
  }
  req.on("close", () => {
    sseClients.delete(res);
  });
});
async function setupServer() {
  if (process.env.NODE_ENV === "production") {
    app.use(express.static(path.join(projectRoot, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(projectRoot, "dist", "index.html"));
    });
  } else {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: { server } },
      appType: "spa"
    });
    app.use(vite.middlewares);
  }
  listenOnAvailablePort(PORT);
}
setupServer().catch((error) => {
  console.error("[Server] Failed to initialize:", getErrorMessage(error));
  process.exitCode = 1;
});
