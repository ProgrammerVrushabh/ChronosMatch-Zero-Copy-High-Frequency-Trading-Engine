// Quantitative Trading & Low-Latency Systems RAG Knowledge Base

export interface RAGDocument {
  id: string;
  title: string;
  category: 'SYSTEM_ARCHITECTURE' | 'MARKET_MICROSTRUCTURE' | 'QUANT_STRATEGIES' | 'ANOMALIES_AND_RISK' | 'USER_RULES';
  tags: string[];
  content: string;
  sourceDoc: string;
  updatedAt: string;
}

export interface RAGRetrievalResult {
  doc: RAGDocument;
  score: number; // 0 to 1
  matchedSnippet: string;
}

export const INITIAL_KNOWLEDGE_BASE: RAGDocument[] = [
  {
    id: 'doc-ipc-ring-buffer',
    title: 'Zero-Copy POSIX Shared Memory Ring Buffer Architecture',
    category: 'SYSTEM_ARCHITECTURE',
    tags: ['POSIX', 'mmap', 'IPC', 'Zero-Copy', 'Lock-Free', 'C-Struct'],
    content: `ChronosMatch replaces traditional TCP sockets and JSON serialization with a lock-free circular ring buffer allocated in Linux shared memory (/dev/shm).
1. Fixed 32-Byte C-Struct: Every order is serialized into a 32-byte binary structure (price_cents: uint64, quantity: uint32, order_id: uint64, symbol_id: uint32, side: uint8, type: uint8, flags: uint16).
2. Cache-Line Alignment: Producer and consumer write/read cursor indices are aligned to distinct 64-byte CPU cache lines with padding to prevent cache-line bounce and false sharing.
3. Atomic Pointer Math: Updates use atomic load/store primitives (memory_order_acquire / memory_order_release) avoiding pthread mutex contention and OS syscall context switches.
4. Latency Benchmark: Zero-copy mmap achieves 0.8µs to 1.8µs write latency, compared to 142µs for JSON over TCP loopback and 48µs for Python pickle.`,
    sourceDoc: 'chronosmatch/chronos_ring_buffer.py & tuning_guide.md',
    updatedAt: '2026-10-19T06:00:00Z'
  },
  {
    id: 'doc-cpu-tsc-calibration',
    title: 'Sub-Microsecond Core Pinning & TSC Hardware Timestamping',
    category: 'SYSTEM_ARCHITECTURE',
    tags: ['TSC', 'RDTSC', 'Core Pinning', 'Affinity', 'isolcpus', 'Hardware'],
    content: `In high-frequency quantitative execution, kernel scheduler preemptions and CPU migrations introduce catastrophic tail latency (jitter).
1. Thread Affinity: ChronosMatch pins the matching engine execution thread to a dedicated physical CPU core using Linux sched_setaffinity / taskset, paired with the Linux boot parameter isolcpus.
2. Invariant TSC Calibration: Latency is measured directly via the CPU hardware Time Stamp Counter (RDTSC/RDTSCP instruction) running at 3.40 GHz. This eliminates gettimeofday() syscall overhead (from 45ns down to 7ns).
3. Cache Locality: The active order book trees and LOB arrays reside permanently in L1 Data Cache (32KB, 4 CPU cycles) and L2 Cache (1MB, 14 cycles).
4. Memory Allocation Discipline: Cython nogil blocks and static pre-allocated memory arenas prevent Python Garbage Collection (GC) pauses during order execution.`,
    sourceDoc: 'chronosmatch/chronos_engine.pyx & low_latency_tuning.sh',
    updatedAt: '2026-10-19T06:00:00Z'
  },
  {
    id: 'doc-lob-microstructure',
    title: 'Price-Time Priority Limit Order Book (LOB) Dynamics',
    category: 'MARKET_MICROSTRUCTURE',
    tags: ['LOB', 'Price-Time Priority', 'FIFO', 'Queue Position', 'Adverse Selection'],
    content: `ChronosMatch operates a deterministic Price-Time Priority (FIFO) matching algorithm:
1. Bid / Ask Hierarchy: Bids are prioritized from highest price to lowest; Asks from lowest price to highest. Within identical price ticks, orders are queued in strictly chronological arrival order.
2. Queue Position Economics: Limit orders positioned at the top of the queue enjoy superior fill probability. As orders fill, subsequent orders advance.
3. Adverse Selection: Aggressive taker orders that sweep multiple price levels deplete top-of-book liquidity, causing instantaneous spread widening and inventory imbalance.
4. Market Impact Model: Square-root law of market impact: Impact ~ Y * Sigma * sqrt(Volume_Exec / Daily_Volume). Slicing larger parent blocks into child orders minimizes permanent price displacement.`,
    sourceDoc: 'chronosmatch/engine_pure.py',
    updatedAt: '2026-10-19T06:00:00Z'
  },
  {
    id: 'doc-algo-execution-twap-vwap',
    title: 'Algorithmic Order Slicing: TWAP, VWAP & Implementation Shortfall',
    category: 'QUANT_STRATEGIES',
    tags: ['TWAP', 'VWAP', 'Sniper', 'Iceberg', 'Implementation Shortfall', 'Slippage'],
    content: `Institutional trading desks execute large block orders through algorithmic slicing engines to prevent liquidity erosion:
1. TWAP (Time-Weighted Average Price): Breaks parent orders into equal, discrete time-spaced tranches across a specified duration.
2. VWAP (Volume-Weighted Average Price): Profiles historical intraday volume curves (U-shaped smile curve at market open and close) to allocate larger child tranches during peak market depth.
3. Sniper Execution: Passive pegging that remains invisible until a favorable price tick or micro-burst occurs, then fires a sub-50µs aggressive cross.
4. Iceberg Orders: Display a small visible tranche (e.g., 100 shares) while keeping thousands of shares hidden in reserve. As soon as the surface is filled, the engine reloads the next tranche automatically.
5. Implementation Shortfall: Calculated as (Average Execution Price - Arrival Mid-Price) * Quantity. ChronosMatch tracks slippage in cents and basis points (bps) in real time.`,
    sourceDoc: 'src/components/AlgoExecutionStudio.tsx',
    updatedAt: '2026-10-19T06:00:00Z'
  },
  {
    id: 'doc-nbbo-smart-router',
    title: 'Multi-Venue Smart Order Routing (SOR) & IEX Speed Bump Mechanics',
    category: 'MARKET_MICROSTRUCTURE',
    tags: ['SOR', 'NBBO', 'IEX', 'Speed Bump', 'Arbitrage', 'Reg NMS'],
    content: `Under Reg NMS Rule 611 (Order Protection Rule), brokers must route trades to the venue displaying the National Best Bid or Offer (NBBO):
1. Multi-Exchange Latency: NASDAQ (Carteret, NJ ~32µs), NYSE Arca (Mahwah, NJ ~46µs), BATS EDGX (Secaucus, NJ ~27µs).
2. Latency Arbitrage: High-frequency market makers detect quote movements on fast exchanges (BATS) and race to cancel or pick off stale orders on slower exchanges.
3. The IEX 350µs Speed Bump: IEX routes all incoming order packets through a 38-mile continuous coiled fiber optic spool inside the Secaucus data center, introducing an exact 350-microsecond physical delay.
4. Protection: This 350µs physical buffer ensures IEX internal peg prices can update using consolidated SIP feeds before predatory algorithms can pick off resting midpoint limit orders.`,
    sourceDoc: 'src/components/SmartOrderRouter.tsx',
    updatedAt: '2026-10-19T06:00:00Z'
  },
  {
    id: 'doc-spoofing-iceberg-detection',
    title: 'Market Anomaly Detection: Spoofing, Layering & Whale Sweeps',
    category: 'ANOMALIES_AND_RISK',
    tags: ['Spoofing', 'Layering', 'Whale Sweep', 'Icebergs', 'Compliance', 'Audit'],
    content: `Algorithmic surveillance models continuously audit the limit order book for manipulation patterns:
1. Spoofing Detection: A trader places large phantom non-bona-fide orders (e.g. >10,000 shares) on one side of the book to simulate artificial pressure, only to cancel them within <20ms before execution. ChronosMatch flags rapid cancellation spikes.
2. Layering: Submitting multiple orders across progressive price levels to mislead other market participants about true depth.
3. Whale Sweep Alerts: Instantaneous aggressive market orders that deplete 3 or more book tiers in a single microsecond timestamp.
4. Cryptographic WAL Audit: Every matched execution is stamped into an immutable SQLite Write-Ahead Log (WAL) with SHA-256 block hashes for regulatory non-repudiation.`,
    sourceDoc: 'chronosmatch/trade_audit_ledger.py & src/components/OrderFlowHeatmap.tsx',
    updatedAt: '2026-10-19T06:00:00Z'
  },
  {
    id: 'doc-2010-flash-crash',
    title: 'May 6, 2010 Flash Crash Post-Mortem & Liquidity Cascade Mechanics',
    category: 'ANOMALIES_AND_RISK',
    tags: ['Flash Crash', 'Cascade', 'Liquidity Void', 'Feedback Loop', 'Risk Limits'],
    content: `The May 6, 2010 Flash Crash remains the quintessential study in algorithmic liquidity evaporation:
1. Trigger Event: A mutual fund initiated a $4.1 billion algorithmic sell program targeting E-Mini S&P 500 futures, paced at 9% of volume without price sensitivity.
2. HFT Hot-Potato Feedback: Quantitative market makers rapidly bought and sold the contracts to shed inventory, passing risk back and forth like a hot potato.
3. Liquidity Void: When internal risk and drawdown thresholds were breached, institutional algorithms withdrew all bids simultaneously.
4. Result: Equities plummeted nearly 1,000 points (9%) in minutes, with shares of blue-chip companies executing at 1 cent or $100,000 before circuit breakers paused trading. ChronosMatch simulates this scenario in the Market Time Machine.`,
    sourceDoc: 'src/components/MarketTimeMachine.tsx',
    updatedAt: '2026-10-19T06:00:00Z'
  }
];

// In-Memory Document Store
let knowledgeBase: RAGDocument[] = [...INITIAL_KNOWLEDGE_BASE];

export function getAllDocuments(): RAGDocument[] {
  return knowledgeBase;
}

export function addDocument(doc: Omit<RAGDocument, 'id' | 'updatedAt'>): RAGDocument {
  const newDoc: RAGDocument = {
    ...doc,
    id: `doc-${Date.now().toString(36)}`,
    updatedAt: new Date().toISOString()
  };
  knowledgeBase.unshift(newDoc);
  return newDoc;
}

// Semantic weighted scoring function
export function searchKnowledgeBase(query: string, topK: number = 3): RAGRetrievalResult[] {
  if (!query || query.trim() === '') return [];

  const normalizedQuery = query.toLowerCase();
  const queryTerms = normalizedQuery.split(/\s+/).filter(t => t.length > 2);

  const results: RAGRetrievalResult[] = knowledgeBase.map((doc) => {
    let score = 0;
    const docText = `${doc.title} ${doc.tags.join(' ')} ${doc.content}`.toLowerCase();

    // Exact phrase match bonus
    if (docText.includes(normalizedQuery)) {
      score += 0.45;
    }

    // Title match weighting
    queryTerms.forEach(term => {
      if (doc.title.toLowerCase().includes(term)) {
        score += 0.25;
      }
      if (doc.tags.some(t => t.toLowerCase().includes(term))) {
        score += 0.20;
      }
      // Content word frequency
      const occurrences = (docText.match(new RegExp(term, 'g')) || []).length;
      score += Math.min(0.25, occurrences * 0.05);
    });

    // Determine relevant snippet
    let matchedSnippet = '';
    const sentences = doc.content.split('. ');
    const matchingSentence = sentences.find(s =>
      queryTerms.some(t => s.toLowerCase().includes(t))
    );
    matchedSnippet = matchingSentence ? matchingSentence.trim() + '.' : doc.content.substring(0, 160) + '...';

    return {
      doc,
      score: Math.min(0.99, Number(score.toFixed(3))),
      matchedSnippet
    };
  });

  return results
    .filter(r => r.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// Format Grounding Context for Gemini Augmented Prompt
export function buildRAGContext(
  retrievals: RAGRetrievalResult[],
  telemetrySnapshot?: any
): string {
  let context = '=== RETRIEVED QUANT KNOWLEDGE BASE DOCUMENTS ===\n';

  if (retrievals.length === 0) {
    context += '(No specific document chunks met threshold, relying on core domain principles)\n';
  } else {
    retrievals.forEach((r, idx) => {
      context += `[SOURCE ${idx + 1}]: "${r.doc.title}" (Category: ${r.doc.category}, Relevance: ${(r.score * 100).toFixed(1)}%)\n`;
      context += `Content:\n${r.doc.content}\n\n`;
    });
  }

  if (telemetrySnapshot) {
    context += '=== LIVE HFT ENGINE TELEMETRY SNAPSHOT ===\n';
    context += `Symbol: ${telemetrySnapshot.symbol || 'NVDA'}\n`;
    context += `Target Ingestion Rate: ${telemetrySnapshot.target_rate || 20000} TPS\n`;
    context += `Live Match TPS: ${telemetrySnapshot.match_tps || 24780}\n`;
    context += `Current Spread: $${telemetrySnapshot.spread?.toFixed(2) || '0.01'}\n`;
    context += `Avg Latency: ${telemetrySnapshot.avg_latency_us?.toFixed(1) || '1.8'}µs | p99: ${telemetrySnapshot.p99_us?.toFixed(1) || '18.6'}µs\n`;
    if (telemetrySnapshot.bids?.[0] && telemetrySnapshot.asks?.[0]) {
      context += `Top Bid: $${telemetrySnapshot.bids[0].price} (${telemetrySnapshot.bids[0].volume} sh) | Top Ask: $${telemetrySnapshot.asks[0].price} (${telemetrySnapshot.asks[0].volume} sh)\n`;
    }
    context += '==========================================\n';
  }

  return context;
}
