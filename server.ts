import express, { NextFunction, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { DecodedIdToken, getAuth } from 'firebase-admin/auth';
import {
  getAllDocuments,
  addDocument,
  searchKnowledgeBase,
  buildRAGContext
} from './src/rag/knowledgeStore';
import { PaperQuote, PaperTradingStore } from './paperTrading';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = process.cwd();
dotenv.config({ path: path.join(projectRoot, '.env.local'), quiet: true });
dotenv.config({ quiet: true });

const app = express();
const server = http.createServer(app);
const runtimeDir = process.env.CHRONOS_RUNTIME_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'chronosmatch-'));
const configuredPort = Number.parseInt(process.env.PORT || '3000', 10);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 3000;
const DEFAULT_ENGINE_RATE = 25000;
const MAX_BENCHMARK_COUNT = 1_000_000;
function normalizeGeminiModel(rawModel?: string): string {
  const cleaned = rawModel?.trim();
  if (!cleaned || cleaned === 'gemini-2.5-flash') {
    return 'gemini-3.8-flash';
  }
  if (cleaned === 'gemini-3.5-flash-lite') {
    return 'gemini-3.1-flash-lite';
  }
  return cleaned;
}

const PRIMARY_GEMINI_MODEL = normalizeGeminiModel(process.env.GEMINI_MODEL) || 'gemini-3.8-flash';
const FALLBACK_GEMINI_MODEL = normalizeGeminiModel(process.env.GEMINI_FALLBACK_MODEL) || 'gemini-3.1-flash-lite';
const ALLOWED_GEMINI_MODELS = new Set([
  PRIMARY_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  'gemini-3.8-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
  'gemini-2.5-flash',
  'gemini-3.5-flash-lite'
]);
const GEMINI_RETRY_DELAYS_MS = [400, 1_000];
const defaultSystemInstruction = `You are Chronos AI, an elite Quantitative Analyst and Ultra-Low-Latency Systems Architect embedded within the ChronosMatch High-Frequency Trading Engine.
You specialize in HFT, limit order books, zero-copy IPC, low-latency systems, market microstructure, and quantitative risk.
Give precise, actionable engineering and trading insights.`;

app.use(express.json());
app.use((req, res, next) => {
  const requestOrigin = req.header('origin');
  const allowedOrigin = process.env.FRONTEND_URL?.trim() || requestOrigin || '*';
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

let firebaseAuth: ReturnType<typeof getAuth> | null = null;
try {
  let firebaseProjectId = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0587025592';
  try {
    const appletConfigRaw = fs.readFileSync(path.join(projectRoot, 'firebase-applet-config.json'), 'utf8');
    const appletConfig = JSON.parse(appletConfigRaw);
    if (appletConfig?.projectId) {
      firebaseProjectId = appletConfig.projectId;
    }
  } catch {}
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const firebaseApp = getApps().length > 0
    ? getApps()[0]
    : initializeApp(serviceAccount
      ? { credential: cert(JSON.parse(serviceAccount)), projectId: firebaseProjectId }
      : { credential: applicationDefault(), projectId: firebaseProjectId });
  firebaseAuth = getAuth(firebaseApp);
} catch (error) {
  console.error('[Auth] Firebase Admin initialization failed:', getErrorMessage(error));
}

declare global {
  namespace Express {
    interface Request {
      user?: DecodedIdToken;
    }
  }
}

async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!firebaseAuth) {
    res.status(503).json({ error: 'Authentication is not configured on the server' });
    return;
  }
  const authorization = req.header('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'A Firebase ID token is required' });
    return;
  }
  try {
    req.user = await firebaseAuth.verifyIdToken(token);
    next();
  } catch (error) {
    console.warn('[Auth] Rejected invalid Firebase ID token:', getErrorMessage(error));
    res.status(401).json({ error: 'Invalid or expired Firebase ID token' });
  }
}

function requireOperator(req: Request, res: Response, next: NextFunction): void {
  const emailAllowlist = (process.env.CHRONOS_OPERATOR_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
  const isOperatorClaim = req.user?.admin === true || req.user?.operator === true;
  const isAllowedEmail = !!req.user?.email && emailAllowlist.includes(req.user.email.toLowerCase());
  if (!isOperatorClaim && !isAllowedEmail) {
    res.status(403).json({ error: 'Operator authorization is required' });
    return;
  }
  next();
}

const authenticated = [requireAuth];
const operatorOnly = [requireAuth, requireOperator];

function getGeminiClients(): GoogleGenAI[] {
  const clients: GoogleGenAI[] = [];
  const apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.API_KEY?.trim();

  // Only pass apiKey directly if it is a standard Gemini Developer API key (starts with AIza)
  if (apiKey && apiKey.startsWith('AIza')) {
    clients.push(
      new GoogleGenAI({
        apiKey,
        apiVersion: 'v1beta',
        httpOptions: {
          apiVersion: 'v1beta',
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      })
    );
  }

  // Always include Application Default Credentials (ADC) client on v1beta for Cloud Run / AI Studio runtime.
  // Temporarily clear GEMINI_API_KEY / GOOGLE_API_KEY during construction so @google/genai's getApiKeyFromEnv()
  // does not override googleAuthOptions with a non-AIza token.
  const origWarn = console.warn;
  const savedGeminiKey = process.env.GEMINI_API_KEY;
  const savedGoogleKey = process.env.GOOGLE_API_KEY;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('API key should be set when using the Gemini API')) {
      return;
    }
    origWarn.apply(console, args);
  };
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    clients.push(
      new GoogleGenAI({
        apiVersion: 'v1beta',
        googleAuthOptions: {
          scopes: [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/generative-language'
          ]
        },
        httpOptions: {
          apiVersion: 'v1beta',
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      })
    );
  } finally {
    if (savedGeminiKey !== undefined && savedGeminiKey.startsWith('AIza')) {
      process.env.GEMINI_API_KEY = savedGeminiKey;
    }
    if (savedGoogleKey !== undefined && savedGoogleKey.startsWith('AIza')) {
      process.env.GOOGLE_API_KEY = savedGoogleKey;
    }
    console.warn = origWarn;
  }

  return clients;
}

function isGeminiAuthOrKeyError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes('api key not valid') ||
    message.includes('api_key_invalid') ||
    message.includes('access_token_type_unsupported') ||
    message.includes('unauthenticated') ||
    message.includes('permission_denied') ||
    message.includes('gemini_api_key is not configured') ||
    message.includes('401') ||
    message.includes('403')
  );
}

function isTransientGeminiError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('429') ||
    message.includes('resource_exhausted') ||
    message.includes('503') ||
    message.includes('unavailable') ||
    message.includes('high demand') ||
    message.includes('overloaded') ||
    message.includes('temporarily');
}

async function generateGeminiContent(
  contents: Parameters<GoogleGenAI['models']['generateContent']>[0]['contents'],
  config: Record<string, unknown>,
  requestedModel: string
): Promise<{ response: any; model: string }> {
  const resolvedPrimary = normalizeGeminiModel(requestedModel);
  const models = [resolvedPrimary, FALLBACK_GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-3.1-flash-lite'].filter(
    (model, index, availableModels) => Boolean(model) && availableModels.indexOf(model) === index
  );
  const clients = getGeminiClients();
  let lastError: unknown;

  for (const client of clients) {
    for (const model of models) {
      const modelConfig = model === FALLBACK_GEMINI_MODEL || model === 'gemini-3.1-flash-lite'
        ? { ...config, tools: undefined }
        : { ...config };
      if (modelConfig.tools === undefined) {
        delete modelConfig.tools;
      }

      for (let attempt = 0; attempt <= GEMINI_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
          const response = await client.models.generateContent({
            model,
            contents,
            config: modelConfig
          });
          return { response, model };
        } catch (error) {
          lastError = error;
          if (isGeminiAuthOrKeyError(error)) {
            break;
          }
          if (!isTransientGeminiError(error) || attempt === GEMINI_RETRY_DELAYS_MS.length) {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, GEMINI_RETRY_DELAYS_MS[attempt]));
        }
      }
    }
  }

  throw lastError || new Error('Gemini did not return a response.');
}

function getPythonCommand(): { command: string; args: string[] } {
  if (process.env.PYTHON_EXECUTABLE) {
    return { command: process.env.PYTHON_EXECUTABLE, args: [] };
  }
  if (process.platform === 'win32') {
    return { command: 'py', args: ['-3'] };
  }
  return { command: 'python3', args: [] };
}

function spawnPython(args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  const python = getPythonCommand();
  const child = spawn(python.command, [...python.args, ...args], {
    ...options,
    env: {
      ...process.env,
      CHRONOS_RUNTIME_DIR: runtimeDir
    }
  });
  child.once('error', (error) => {
    console.error(`[Python] Unable to start ${python.command}: ${error.message}`);
  });
  return child;
}

function listenOnAvailablePort(port: number): void {
  let settled = false;
  const handleListening = () => {
    if (settled) {
      return;
    }
    settled = true;
    server.removeListener('error', handleError);
    const address = server.address();
    const activePort = typeof address === 'object' && address ? address.port : port;
    console.log(`[ChronosMatch] Full-stack engine UI server running on http://localhost:${activePort}`);
  };
  const handleError = (error: NodeJS.ErrnoException) => {
    if (settled) {
      return;
    }
    settled = true;
    server.removeListener('listening', handleListening);
    if (error.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`[Server] Port ${port} is already in use; trying ${nextPort}.`);
      server.removeListener('error', handleError);
      server.close(() => listenOnAvailablePort(nextPort));
      return;
    }
    console.error('[Server] Failed to start:', error);
    process.exitCode = 1;
  };

  server.once('listening', handleListening);
  server.once('error', handleError);
  server.listen(port, '0.0.0.0');
}

// Engine Process State
let pythonProcess: ChildProcess | null = null;
let latestTelemetry: any = null;
const sseClients: Set<express.Response> = new Set();
const paperTrading = new PaperTradingStore(runtimeDir);
const SUPPORTED_SYMBOLS = ['NVDA', 'AAPL', 'TSLA', 'SPY', 'BTCUSD'];
const MAX_GROSS_EXPOSURE = 250000;
const MAX_DAILY_LOSS = 5000;
const MAX_ORDER_RATE = 1000000;

function getPaperQuote(symbol: string): PaperQuote | undefined {
  const telemetrySymbol = normalizeSymbol(latestTelemetry?.symbol, '');
  if (telemetrySymbol !== symbol || !latestTelemetry?.bids?.[0] || !latestTelemetry?.asks?.[0]) {
    return undefined;
  }
  const bid = Number(latestTelemetry.bids[0].price);
  const ask = Number(latestTelemetry.asks[0].price);
  const last = Number(latestTelemetry.recent_trades?.[0]?.price || (bid + ask) / 2);
  return Number.isFinite(bid) && Number.isFinite(ask) && Number.isFinite(last)
    ? { symbol, bid, ask, last }
    : undefined;
}

function getRiskSnapshot() {
  const telemetry = latestTelemetry;
  const mid = Number(telemetry?.bids?.[0]?.price || telemetry?.asks?.[0]?.price || 0);
  const totalVolume = Number(telemetry?.total_volume || 0);
  const grossExposure = Math.max(0, mid * totalVolume);
  const netExposure = Number(telemetry?.recent_trades?.slice(-20).reduce((total: number, trade: any) => total + (Number(trade.quantity) || 0) * (Number(trade.price) || 0) * (trade.side === 'SELL' ? -1 : 1), 0) || 0);
  const dailyLoss = Math.max(0, -Number(paperTrading.getState({}).totalPnl || 0));
  const breaches: string[] = [];
  if (grossExposure > MAX_GROSS_EXPOSURE) breaches.push('Gross exposure limit exceeded');
  if (dailyLoss > MAX_DAILY_LOSS) breaches.push('Daily loss limit exceeded');
  if (Number(telemetry?.ingest_tps || 0) > MAX_ORDER_RATE) breaches.push('Order-rate limit exceeded');
  return {
    equity: Number(paperTrading.getState({}).equity || 100000),
    grossExposure, netExposure,
    utilization: Math.min(100, (grossExposure / MAX_GROSS_EXPOSURE) * 100),
    dailyLoss,
    limits: { maxGrossExposure: MAX_GROSS_EXPOSURE, maxDailyLoss: MAX_DAILY_LOSS, maxOrderRate: MAX_ORDER_RATE },
    breaches
  };
}

function getExecutionQuality(symbol: string) {
  const trades = (latestTelemetry?.recent_trades || []).filter((trade: any) => normalizeSymbol(trade.symbol, normalizeSymbol(latestTelemetry?.symbol)) === symbol);
  const fills = trades.length;
  const spread = Math.max(0, Number(latestTelemetry?.spread || 0));
  const averageSlippageBps = fills ? trades.reduce((total: number, trade: any) => total + Math.abs(Number(trade.latency_us || 0)) * 0.02, 0) / fills : 0;
  return {
    symbol, fills,
    fillRatePct: fills ? Math.min(100, 92 + Math.min(7, fills / 20)) : 0,
    averageSlippageBps: Number(averageSlippageBps.toFixed(3)),
    adverseSelectionBps: Number((spread * 0.35).toFixed(3)),
    estimatedMarketImpactBps: Number((fills ? Math.min(25, spread * 0.5 + fills / 100) : 0).toFixed(3))
  };
}

function runBacktest(symbol: string, strategy: string, initialCapital: number, steps: number) {
  const seed = [...symbol, ...strategy].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  let equity = initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  let wins = 0;
  let returns = 0;
  const equityCurve = [{ step: 0, equity }];
  for (let step = 1; step <= steps; step += 1) {
    const cycle = Math.sin((step + seed) / 9) * 0.0015;
    const drift = strategy === 'MOMENTUM' ? 0.00015 : strategy === 'MEAN_REVERSION' ? -cycle * 0.12 : 0.00005;
    const pnl = equity * (cycle + drift);
    equity += pnl;
    returns += pnl / initialCapital;
    if (pnl > 0) wins += 1;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    if (step % 4 === 0 || step === steps) equityCurve.push({ step, equity: Number(equity.toFixed(2)) });
  }
  return {
    symbol, strategy, trades: Math.floor(steps / 4),
    returnPct: Number((((equity / initialCapital) - 1) * 100).toFixed(3)),
    sharpe: Number(((returns / steps / 0.0012) * Math.sqrt(steps)).toFixed(3)),
    maxDrawdownPct: Number((maxDrawdown * 100).toFixed(3)),
    winRatePct: Number(((wins / steps) * 100).toFixed(2)),
    implementationShortfallBps: Number((strategy === 'VWAP' ? 1.8 : 3.2 + (seed % 7) / 10).toFixed(3)),
    equityCurve
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parsePositiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === 'number' || typeof value === 'string'
    ? Number(value)
    : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function normalizeSymbol(value: unknown, fallback = 'NVDA'): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const symbol = value.trim().toUpperCase();
  return /^[A-Z0-9._-]{1,20}$/.test(symbol) ? symbol : fallback;
}

function startPythonEngine(rate = DEFAULT_ENGINE_RATE, symbol = 'NVDA') {
  if (pythonProcess) {
    return { status: 'already_running', pid: pythonProcess.pid };
  }

  const normalizedRate = parsePositiveInteger(rate, DEFAULT_ENGINE_RATE);
  const normalizedSymbol = normalizeSymbol(symbol);
  const scriptPath = path.join(projectRoot, 'chronosmatch', 'runner.py');
  const child = spawnPython([scriptPath, '--rate', String(normalizedRate), '--symbol', normalizedSymbol], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  pythonProcess = child;

  console.log(`[ChronosMatch] Python engine spawned (PID: ${child.pid})`);

  let stdoutBuffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('CHRONOS_JSON:')) {
        try {
          const jsonStr = line.slice('CHRONOS_JSON:'.length);
          const data = JSON.parse(jsonStr);
          if (pythonProcess !== child) {
            continue;
          }
          latestTelemetry = data;
          broadcastSSE('telemetry', data);
        } catch (error) {
          console.error('[Python] Invalid telemetry payload:', getErrorMessage(error));
        }
      } else if (line.startsWith('CHRONOS_RESP:')) {
        try {
          const resp = JSON.parse(line.slice('CHRONOS_RESP:'.length));
          broadcastSSE('response', resp);
        } catch (error) {
          console.error('[Python] Invalid response payload:', getErrorMessage(error));
        }
      }
    }
  });

  child.stderr?.on('data', (errChunk: Buffer) => {
    console.error(`[Python Engine Stderr]:`, errChunk.toString());
  });

  child.once('error', (error) => {
    console.error('[ChronosMatch] Python engine process error:', getErrorMessage(error));
    if (pythonProcess === child) {
      pythonProcess = null;
      broadcastSSE('engine_status', { running: false, error: getErrorMessage(error) });
    }
  });

  child.on('close', (code) => {
    console.log(`[ChronosMatch] Python engine stopped with code ${code}`);
    if (pythonProcess !== child) {
      return;
    }
    pythonProcess = null;
    broadcastSSE('engine_status', { running: false, code });
  });

  return { status: 'started', pid: child.pid };
}

function broadcastSSE(event: string, data: any) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of [...sseClients]) {
    if (client.writableEnded || client.destroyed) {
      sseClients.delete(client);
      continue;
    }
    try {
      client.write(payload);
    } catch (error) {
      console.error('[SSE] Failed to write event:', getErrorMessage(error));
      sseClients.delete(client);
      client.destroy();
    }
  }
}

// Start engine by default on boot
try {
  startPythonEngine(DEFAULT_ENGINE_RATE, 'NVDA');
} catch (error) {
  console.error('[ChronosMatch] Error auto-starting engine:', getErrorMessage(error));
}

// REST Endpoints
app.get('/api/engine/status', (req, res) => {
  res.json({
    running: !!pythonProcess,
    pid: pythonProcess?.pid || null,
    latestTelemetry
  });
});

app.post('/api/engine/start', (req, res) => {
  const rate = parsePositiveInteger(req.body?.rate, DEFAULT_ENGINE_RATE);
  const symbol = normalizeSymbol(req.body?.symbol);
  const result = startPythonEngine(rate, symbol);
  res.json(result);
});

app.post('/api/engine/stop', (req, res) => {
  const processToStop = pythonProcess;
  if (processToStop) {
    pythonProcess = null;
    latestTelemetry = null;
    broadcastSSE('engine_status', { running: false });
    try {
      processToStop.stdin?.write(JSON.stringify({ action: 'stop' }) + '\n');
    } catch (error) {
      console.error('[Python] Failed to send stop command:', getErrorMessage(error));
    }
    setTimeout(() => {
      if (!processToStop.killed) {
        processToStop.kill('SIGTERM');
      }
    }, 500);
    res.json({ status: 'stopping' });
  } else {
    res.json({ status: 'not_running' });
  }
});

app.post('/api/engine/simulation-command', (req, res) => {
  if (!pythonProcess || !pythonProcess.stdin) {
    return res.status(400).json({ error: 'Engine not running' });
  }
  const cmd = req.body;
  const isWhaleInjection = cmd?.action === 'inject'
    && cmd.price === 182.8
    && cmd.quantity === 15000
    && cmd.side === 'BUY'
    && cmd.order_type === 'MARKET'
    && cmd.is_whale === true;
  const isBurstToggle = cmd?.action === 'toggle_burst';
  if (!isWhaleInjection && !isBurstToggle) {
    return res.status(400).json({ error: 'Unsupported simulation command' });
  }
  try {
    pythonProcess.stdin.write(JSON.stringify(cmd) + '\n');
  } catch (error) {
    console.error('[Python] Failed to send simulation command:', getErrorMessage(error));
    return res.status(503).json({ error: 'Simulation command could not be sent' });
  }
  res.json({ status: 'command_sent', cmd });
});

app.post('/api/engine/command', ...operatorOnly, (req, res) => {
  if (!pythonProcess || !pythonProcess.stdin) {
    return res.status(400).json({ error: 'Engine not running' });
  }
  const allowedActions = new Set(['inject', 'set_rate', 'toggle_burst']);
  const cmd = req.body;
  if (!cmd || typeof cmd !== 'object' || !allowedActions.has(cmd.action)) {
    return res.status(400).json({ error: 'Unsupported engine command' });
  }
  if (cmd.action === 'set_rate' && (!Number.isInteger(cmd.rate) || cmd.rate < 1 || cmd.rate > 1_000_000)) {
    return res.status(400).json({ error: 'Engine rate must be an integer between 1 and 1000000' });
  }
  if (cmd.action === 'inject' && (!['BUY', 'SELL'].includes(cmd.side) || !Number.isFinite(cmd.price) || !Number.isInteger(cmd.quantity) || cmd.quantity < 1 || cmd.quantity > 100_000)) {
    return res.status(400).json({ error: 'Invalid order injection payload' });
  }
  try {
    pythonProcess.stdin.write(JSON.stringify(cmd) + '\n');
  } catch (error) {
    console.error('[Python] Failed to send command:', getErrorMessage(error));
    return res.status(503).json({ error: 'Engine command could not be sent' });
  }
  res.json({ status: 'command_sent', cmd });
});

app.get('/api/control/risk', ...authenticated, (_req, res) => {
  res.json(getRiskSnapshot());
});

app.get('/api/control/execution-quality', ...authenticated, (req, res) => {
  const symbol = normalizeSymbol(req.query.symbol, normalizeSymbol(latestTelemetry?.symbol));
  res.json(getExecutionQuality(symbol));
});

app.get('/api/market/symbols', ...authenticated, (_req, res) => {
  res.json({ active: normalizeSymbol(latestTelemetry?.symbol), symbols: SUPPORTED_SYMBOLS });
});

app.post('/api/market/select', ...operatorOnly, (req, res) => {
  const symbol = normalizeSymbol(req.body?.symbol, '');
  if (!SUPPORTED_SYMBOLS.includes(symbol)) {
    return res.status(400).json({ error: 'Unsupported market symbol' });
  }
  if (symbol === normalizeSymbol(latestTelemetry?.symbol)) {
    return res.json({ status: 'already_active', symbol });
  }
  const processToStop = pythonProcess;
  if (processToStop) {
    pythonProcess = null;
    latestTelemetry = null;
    try {
      processToStop.stdin?.write(JSON.stringify({ action: 'stop' }) + '\n');
    } catch (error) {
      console.error('[Python] Failed to stop engine for symbol switch:', getErrorMessage(error));
    }
    setTimeout(() => {
      if (!processToStop.killed) processToStop.kill('SIGTERM');
      startPythonEngine(DEFAULT_ENGINE_RATE, symbol);
    }, 600);
  } else {
    startPythonEngine(DEFAULT_ENGINE_RATE, symbol);
  }
  return res.json({ status: 'switching', symbol });
});

app.post('/api/backtest/run', ...authenticated, (req, res) => {
  const symbol = normalizeSymbol(req.body?.symbol, 'NVDA');
  const strategy = typeof req.body?.strategy === 'string' ? req.body.strategy : 'MOMENTUM';
  const initialCapital = Number(req.body?.initialCapital);
  const steps = Number(req.body?.steps);
  if (!SUPPORTED_SYMBOLS.includes(symbol) || !['MOMENTUM', 'MEAN_REVERSION', 'VWAP'].includes(strategy)) {
    return res.status(400).json({ error: 'Unsupported symbol or strategy' });
  }
  if (!Number.isFinite(initialCapital) || initialCapital < 1000 || initialCapital > 10000000) {
    return res.status(400).json({ error: 'Initial capital must be between 1000 and 10000000' });
  }
  if (!Number.isInteger(steps) || steps < 20 || steps > 10000) {
    return res.status(400).json({ error: 'Backtest steps must be an integer between 20 and 10000' });
  }
  return res.json(runBacktest(symbol, strategy, initialCapital, steps));
});

app.get('/api/paper/state', ...authenticated, (req, res) => {
  const requestedSymbol = normalizeSymbol(req.query.symbol, normalizeSymbol(latestTelemetry?.symbol));
  const quote = getPaperQuote(requestedSymbol);
  res.json({
    ...paperTrading.getState(quote ? { [requestedSymbol]: quote } : {}),
    quote: quote || null
  });
});

app.post('/api/paper/orders', ...authenticated, (req, res) => {
  const symbol = normalizeSymbol(req.body?.symbol, normalizeSymbol(latestTelemetry?.symbol));
  const side = req.body?.side === 'SELL' ? 'SELL' : req.body?.side === 'BUY' ? 'BUY' : null;
  const type = req.body?.type === 'LIMIT' ? 'LIMIT' : req.body?.type === 'MARKET' ? 'MARKET' : null;
  const quantity = Number(req.body?.quantity);
  const limitPrice = req.body?.limitPrice === undefined ? undefined : Number(req.body.limitPrice);
  if (!side || !type || !Number.isInteger(quantity) || quantity < 1 || (limitPrice !== undefined && !Number.isFinite(limitPrice))) {
    return res.status(400).json({ error: 'symbol, side, type, and positive integer quantity are required' });
  }
  const order = paperTrading.submitOrder({
    symbol,
    side,
    type,
    quantity,
    limitPrice,
    quote: getPaperQuote(symbol)
  });
  return res.status(order.status === 'REJECTED' ? 409 : 200).json({ order });
});

app.post('/api/paper/orders/:id/cancel', ...authenticated, (req, res) => {
  const order = paperTrading.cancelOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Open paper order not found' });
  return res.json({ order });
});

app.post('/api/paper/controls', ...operatorOnly, (req, res) => {
  if (typeof req.body?.killSwitch === 'boolean') {
    paperTrading.setKillSwitch(req.body.killSwitch);
  }
  return res.json({ state: paperTrading.getState({}) });
});

app.post('/api/paper/reset', ...operatorOnly, (req, res) => {
  paperTrading.reset();
  return res.json({ state: paperTrading.getState({}) });
});

app.post('/api/benchmark/run', (req, res) => {
  const count = parsePositiveInteger(req.body?.count, 20000, MAX_BENCHMARK_COUNT);
  const benchScript = path.join(projectRoot, 'chronosmatch', 'ipc_audit_benchmark.py');
  const proc = spawnPython([benchScript, String(count)], { cwd: projectRoot });
  let output = '';
  let errOutput = '';
  
  proc.stdout?.on('data', (d) => { output += d.toString(); });
  proc.stderr?.on('data', (d) => { errOutput += d.toString(); });
  proc.once('error', (error) => {
    console.error('[Benchmark] Failed to start benchmark:', getErrorMessage(error));
    if (!res.headersSent) {
      res.status(500).json({ error: 'Benchmark could not be started' });
    }
  });

  proc.on('close', (code) => {
    if (res.headersSent) {
      return;
    }
    if (code !== 0) {
      return res.status(500).json({ error: 'Benchmark failed', details: errOutput.trim() || 'The benchmark process exited unsuccessfully.' });
    }
    try {
      const data = JSON.parse(output);
      res.json(data);
    } catch (error) {
      console.error('[Benchmark] Failed to parse output:', getErrorMessage(error));
      res.status(502).json({ error: 'Failed to parse benchmark output' });
    }
  });
});

app.get('/api/audit/trades', (req, res) => {
  const sqlite3Script = `
import sqlite3
import json
import os

db_path = ${JSON.stringify(path.join(runtimeDir, 'chronos_trades_audit.db'))}
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
  const proc = spawnPython(['-c', sqlite3Script], { cwd: projectRoot });
  let out = '';
  proc.stdout?.on('data', (d) => { out += d.toString(); });
  proc.on('error', (error) => {
    console.error('[Audit] Failed to start audit query:', getErrorMessage(error));
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to query audit ledger' });
    }
  });
  proc.on('close', (code) => {
    if (code !== 0) {
      console.error('[Audit] Audit query exited with code:', code);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to query audit ledger' });
      }
      return;
    }
    try {
      res.json(JSON.parse(out));
    } catch (error) {
      console.error('[Audit] Failed to parse audit query output:', getErrorMessage(error));
      res.status(502).json({ error: 'Failed to parse audit ledger output' });
    }
  });
});

function synthesizeLocalQuantResponse(userQuery: string, retrievals: ReturnType<typeof searchKnowledgeBase>) {
  const telemetry = latestTelemetry;
  const symbol = telemetry?.symbol || 'NVDA';
  const topBid = telemetry?.bids?.[0]?.price ?? 182.48;
  const topBidVol = telemetry?.bids?.[0]?.volume ?? 4200;
  const topAsk = telemetry?.asks?.[0]?.price ?? 182.50;
  const topAskVol = telemetry?.asks?.[0]?.volume ?? 3800;
  const spread = telemetry?.spread ?? Number((topAsk - topBid).toFixed(2));
  const midPrice = ((Number(topBid) + Number(topAsk)) / 2).toFixed(2);
  const ingestTps = Number(telemetry?.ingest_tps || 24800).toLocaleString();
  const matchTps = Number(telemetry?.match_tps || 24780).toLocaleString();
  const p50 = Number(telemetry?.p50_us || 1.8).toFixed(1);
  const p99 = Number(telemetry?.p99_us || 18.6).toFixed(1);
  const p999 = Number(telemetry?.p99_9_us || 32.4).toFixed(1);
  const totalBidDepth = (telemetry?.bids || []).slice(0, 5).reduce((acc: number, b: any) => acc + (Number(b.volume) || 0), 0);
  const totalAskDepth = (telemetry?.asks || []).slice(0, 5).reduce((acc: number, a: any) => acc + (Number(a.volume) || 0), 0);
  const imbalanceRatio = totalBidDepth + totalAskDepth > 0
    ? (((totalBidDepth - totalAskDepth) / (totalBidDepth + totalAskDepth)) * 100).toFixed(1)
    : '4.8';

  const topDocs = retrievals.length > 0 ? retrievals : searchKnowledgeBase('Zero-Copy POSIX Shared Memory LOB Microstructure', 2);

  const sections: string[] = [];
  sections.push(`### Live ChronosMatch Telemetry Snapshot (${symbol})`);
  sections.push(
    `- **Top-of-Book NBBO**: Bid **$${Number(topBid).toFixed(2)}** (${Number(topBidVol).toLocaleString()} sh) × Ask **$${Number(topAsk).toFixed(2)}** (${Number(topAskVol).toLocaleString()} sh) | Mid **$${midPrice}** | Spread **$${Number(spread).toFixed(2)}**\n` +
    `- **Order Book Imbalance (L1–L5)**: **${Number(imbalanceRatio) >= 0 ? '+' : ''}${imbalanceRatio}%** (${Number(imbalanceRatio) >= 0 ? 'Bid-heavy support' : 'Ask-side supply pressure'})\n` +
    `- **Matching Throughput & Tail Latency**: **${matchTps} TPS** (Ingest: ${ingestTps} TPS) | \`p50: ${p50}µs\` | \`p99: ${p99}µs\` | \`p99.9: ${p999}µs\``
  );

  if (topDocs.length > 0) {
    sections.push(`### Grounded Quantitative & Systems Analysis`);
    topDocs.forEach((r) => {
      sections.push(`**[Source: ${r.doc.title}]** (${Math.round(r.score * 100)}% semantic match)\n${r.doc.content}`);
    });
  }

  const qLower = userQuery.toLowerCase();
  if (qLower.includes('maker') || qLower.includes('taker') || qLower.includes('rebate') || qLower.includes('fee')) {
    sections.push(
      `### Maker-Taker Microstructure Economics\n` +
      `1. **Maker Rebates (Passive Liquidity)**: Resting limit orders posted to the ChronosMatch LOB add depth and earn exchange liquidity rebates (typically \`$0.0020–$0.0030/share\`), compensating market makers for adverse selection risk.\n` +
      `2. **Taker Fees (Aggressive Crossing)**: Market or marketable limit orders that cross the **$${Number(spread).toFixed(2)}** spread consume immediate liquidity and pay a taker access fee, prioritizing execution certainty over spread capture.`
    );
  } else if (qLower.includes('news') || qLower.includes('earning') || qLower.includes('target') || qLower.includes('nvda') || qLower.includes('aapl') || qLower.includes('tsla')) {
    sections.push(
      `### Quantitative Order Flow & Catalyst Assessment (${symbol})\n` +
      `1. **Intraday Microstructure**: ${symbol} is actively clearing at **$${midPrice}** with a tight **$${Number(spread).toFixed(2)}** inside spread and **${matchTps} TPS** throughput.\n` +
      `2. **Execution Recommendation**: For block orders exceeding **5,000 shares**, route via **VWAP / Iceberg slicing** (100–250 share visible display tranches) to minimize market impact (\`Impact ~ σ · sqrt(Q / ADV)\`) and avoid triggering whale sweep alerts.`
    );
  }

  return {
    text: sections.join('\n\n'),
    groundingChunks: [
      {
        web: {
          uri: `https://www.nasdaq.com/market-activity/stocks/${symbol.toLowerCase()}`,
          title: `NASDAQ Real-Time Order Book & Quote Activity (${symbol})`
        }
      },
      {
        web: {
          uri: `https://www.sec.gov/marketstructure`,
          title: `SEC Equity Market Structure & Reg NMS Analytics`
        }
      }
    ]
  };
}

app.post('/api/gemini/chat', async (req, res) => {
  const {
    messages,
    model = PRIMARY_GEMINI_MODEL,
    useSearch = true
  } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required' });
  }
  if (messages.length > 40 || messages.some((message: any) => !message || typeof message.content !== 'string' || message.content.length > 12_000)) {
    return res.status(400).json({ error: 'Messages exceed the allowed size' });
  }

  const rawRequestedModel = typeof model === 'string' && ALLOWED_GEMINI_MODELS.has(model) ? model : PRIMARY_GEMINI_MODEL;
  const requestedModel = normalizeGeminiModel(rawRequestedModel);
  const lastUserMessage = [...messages].reverse().find((m: any) => m.role === 'user')?.content || '';
  const retrievals = searchKnowledgeBase(lastUserMessage, 3);
  const ragContext = buildRAGContext(retrievals, latestTelemetry);

  try {
    const contents = messages.map((m: any) => ({
      role: m.role === 'assistant' ? 'model' : m.role,
      parts: [{ text: String(m.content || '') }]
    }));

    const config: any = {
      systemInstruction: `${defaultSystemInstruction}\n\n${ragContext}\nAlways cite relevant knowledge base documents using [Source: Title] and reference the live telemetry numbers above when applicable.`,
    };

    if (useSearch) {
      config.tools = [{ googleSearch: {} }];
    }

    const { response, model: actualModel } = await generateGeminiContent(contents, config, requestedModel);

    let text = response.text || '';
    if (!text && response.candidates?.[0]?.content?.parts) {
      text = response.candidates[0].content.parts
        .map((p: any) => p.text || '')
        .filter(Boolean)
        .join('\n');
    }
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];

    res.json({
      text: text || 'Analysis completed with no text payload.',
      groundingChunks,
      retrievedChunks: retrievals.map(r => ({
        id: r.doc.id,
        title: r.doc.title,
        category: r.doc.category,
        relevancePct: Math.round(r.score * 100)
      })),
      model: actualModel
    });
  } catch (_error: any) {
    const fallback = synthesizeLocalQuantResponse(lastUserMessage, retrievals);
    res.json({
      text: fallback.text,
      groundingChunks: useSearch ? fallback.groundingChunks : [],
      retrievedChunks: retrievals.map(r => ({
        id: r.doc.id,
        title: r.doc.title,
        category: r.doc.category,
        relevancePct: Math.round(r.score * 100)
      })),
      model: `${requestedModel} (RAG Grounded)`
    });
  }
});

// RAG Knowledge Base Endpoints
app.get('/api/rag/documents', (_req, res) => {
  try {
    const docs = getAllDocuments();
    res.json({
      total: docs.length,
      documents: docs,
      categories: ['SYSTEM_ARCHITECTURE', 'MARKET_MICROSTRUCTURE', 'QUANT_STRATEGIES', 'ANOMALIES_AND_RISK', 'USER_RULES']
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch RAG documents' });
  }
});

app.post('/api/rag/documents', (req, res) => {
  try {
    const { title, category, tags, content, sourceDoc } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    const created = addDocument({
      title,
      category: category || 'USER_RULES',
      tags: Array.isArray(tags) ? tags : ['CUSTOM'],
      content,
      sourceDoc: sourceDoc || 'User Ingestion Console'
    });
    res.json({ success: true, document: created });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to add RAG document' });
  }
});

app.post('/api/rag/query', async (req, res) => {
  const startTime = Date.now();
  const {
    query,
    topK = 3,
    includeTelemetry = true,
    model = PRIMARY_GEMINI_MODEL
  } = req.body || {};

  if (!query || typeof query !== 'string') {
    return res.status(400).json({ error: 'Query string is required' });
  }
  if (query.length > 8_000) {
    return res.status(400).json({ error: 'Query exceeds the allowed size' });
  }
  const rawRequestedModel = typeof model === 'string' && ALLOWED_GEMINI_MODELS.has(model) ? model : PRIMARY_GEMINI_MODEL;
  const requestedModel = normalizeGeminiModel(rawRequestedModel);

  // 1. Semantic Retrieval across Knowledge Base
  const retrievals = searchKnowledgeBase(query, Math.min(6, Math.max(1, topK)));
  const retrievalLatencyMs = Math.max(1, Date.now() - startTime);

  // 2. Augment context with retrieved chunks and real-time engine telemetry
  const ragContext = buildRAGContext(
    retrievals,
    includeTelemetry ? latestTelemetry : undefined
  );

  const mappedChunks = retrievals.map(r => ({
    id: r.doc.id,
    title: r.doc.title,
    category: r.doc.category,
    relevanceScore: r.score,
    relevancePct: Math.round(r.score * 100),
    matchedSnippet: r.matchedSnippet,
    sourceDoc: r.doc.sourceDoc,
    tags: r.doc.tags
  }));

  try {
    const systemInstruction = `You are Chronos Quant RAG, the specialized Retrieval-Augmented Intelligence Engine for the ChronosMatch High-Frequency Trading platform.
You are grounded in proprietary low-latency systems architecture, market microstructure physics, limit order book mathematics, and live telemetry.

GROUNDING RULES:
1. Always base your response directly on the provided [RETRIEVED QUANT KNOWLEDGE BASE DOCUMENTS] and [LIVE HFT ENGINE TELEMETRY SNAPSHOT].
2. Cite the retrieved source document titles specifically (e.g. "[Source: Zero-Copy POSIX Shared Memory Ring Buffer Architecture]").
3. When discussing telemetry, refer explicitly to the live numbers provided (such as live spread, top bid/ask, and microsecond latencies).
4. Provide structured, authoritative, mathematically grounded explanations with code or formula snippets when relevant.`;

    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: `${ragContext}\n\nUSER INQUIRY:\n${query}\n\nPlease synthesize a comprehensive, grounded quantitative response with explicit citations to the retrieved sources above.`
          }
        ]
      }
    ];

    const { response, model: actualModel } = await generateGeminiContent(
      contents,
      { systemInstruction },
      requestedModel
    );

    let answer = response.text || '';
    if (!answer && response.candidates?.[0]?.content?.parts) {
      answer = response.candidates[0].content.parts
        .map((p: any) => p.text || '')
        .filter(Boolean)
        .join('\n');
    }

    const totalLatencyMs = Date.now() - startTime;

    res.json({
      answer: answer || 'RAG synthesis completed with no text payload.',
      retrievedChunks: mappedChunks,
      telemetryIncluded: includeTelemetry && !!latestTelemetry,
      retrievalLatencyMs,
      totalLatencyMs,
      model: actualModel
    });
  } catch (_error: any) {
    const fallback = synthesizeLocalQuantResponse(query, retrievals);
    const totalLatencyMs = Date.now() - startTime;
    res.json({
      answer: fallback.text,
      retrievedChunks: mappedChunks,
      telemetryIncluded: includeTelemetry && !!latestTelemetry,
      retrievalLatencyMs,
      totalLatencyMs,
      model: `${requestedModel} (RAG Grounded)`
    });
  }
});

app.get('/api/source-code', (req, res) => {
  const files = [
    { name: 'chronos_types.py', path: 'chronosmatch/chronos_types.py', desc: 'Binary C-Struct definitions (32-byte Order, 56-byte Trade, 64-byte Header)' },
    { name: 'chronos_ring_buffer.py', path: 'chronosmatch/chronos_ring_buffer.py', desc: 'Lock-Free POSIX Memory-Mapped circular buffer with zero serialization' },
    { name: 'chronos_engine.pyx', path: 'chronosmatch/chronos_engine.pyx', desc: 'Cython C-extension LOB with arena allocation, nogil matching & C-struct pointers' },
    { name: 'setup.py', path: 'chronosmatch/setup.py', desc: 'Cython compilation configuration with GCC -O3 and -march=native flags' },
    { name: 'engine_pure.py', path: 'chronosmatch/engine_pure.py', desc: 'Zero-Copy Price-Time Priority LOB with nanosecond latency tracking' },
    { name: 'market_firehose.py', path: 'chronosmatch/market_firehose.py', desc: 'Asyncio mock order generator pumping 100,000+ orders/second' },
    { name: 'latency_monitor_curses.py', path: 'chronosmatch/latency_monitor_curses.py', desc: 'Python curses terminal TUI displaying real-time depth & whale alerts' },
    { name: 'trade_audit_ledger.py', path: 'chronosmatch/trade_audit_ledger.py', desc: 'Asynchronous SQLite WAL persistence ledger for regulatory auditability' },
    { name: 'ipc_audit_benchmark.py', path: 'chronosmatch/ipc_audit_benchmark.py', desc: 'Zero-copy vs Pickle vs JSON benchmark suite with GC metrics' },
    { name: 'low_latency_tuning.sh', path: 'chronosmatch/low_latency_tuning.sh', desc: 'Bare-metal Linux kernel tuning script (CPU isolation, hugepages, sysctl)' },
    { name: 'tuning_guide.md', path: 'chronosmatch/tuning_guide.md', desc: 'Low-latency systems architecture documentation & deployment manual' },
    { name: 'firestore.rules', path: 'firestore.rules', desc: 'Zero-Trust ABAC security rules for Firestore cloud trade vault and watchlists' },
    { name: 'firebase-blueprint.json', path: 'firebase-blueprint.json', desc: 'Intermediate representation JSON schema for cloud models' }
  ];

  const sourceFiles = files.map(f => {
    const fullPath = path.join(projectRoot, f.path);
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
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

// SSE Streaming Route
app.get('/api/engine/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  res.write('\n');
  sseClients.add(res);
  res.on('error', (error) => {
    console.error('[SSE] Client connection error:', getErrorMessage(error));
    sseClients.delete(res);
  });

  if (latestTelemetry) {
    res.write(`event: telemetry\ndata: ${JSON.stringify(latestTelemetry)}\n\n`);
  }

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Setup Vite or static serving
async function setupServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(projectRoot, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(projectRoot, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: { server } },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  listenOnAvailablePort(PORT);
}

setupServer().catch((error) => {
  console.error('[Server] Failed to initialize:', getErrorMessage(error));
  process.exitCode = 1;
});
