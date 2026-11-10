import fs from 'fs';
import path from 'path';

export type PaperSide = 'BUY' | 'SELL';
export type PaperOrderType = 'MARKET' | 'LIMIT';
export type PaperOrderStatus = 'FILLED' | 'OPEN' | 'CANCELLED' | 'REJECTED';

export interface PaperQuote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: PaperSide;
  type: PaperOrderType;
  quantity: number;
  limitPrice?: number;
  filledQuantity: number;
  averageFillPrice: number;
  status: PaperOrderStatus;
  rejectReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaperPosition {
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
}

export interface PaperRiskLimits {
  maxOrderQuantity: number;
  maxOrderNotional: number;
  maxPositionQuantity: number;
  maxDailyLoss: number;
}

interface PaperState {
  cash: number;
  startingCash: number;
  realizedPnl: number;
  orders: PaperOrder[];
  positions: Record<string, { quantity: number; averagePrice: number }>;
  limits: PaperRiskLimits;
  killSwitch: boolean;
}

const DEFAULT_CASH = 100_000;
const DEFAULT_LIMITS: PaperRiskLimits = {
  maxOrderQuantity: 10_000,
  maxOrderNotional: 50_000,
  maxPositionQuantity: 2_000,
  maxDailyLoss: 5_000
};

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function validPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export class PaperTradingStore {
  private readonly filePath: string;
  private state: PaperState;

  constructor(runtimeDir: string) {
    this.filePath = path.join(runtimeDir, 'paper_trading.json');
    this.state = this.load();
  }

  private load(): PaperState {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<PaperState>;
      return {
        cash: Number(saved.cash) || DEFAULT_CASH,
        startingCash: Number(saved.startingCash) || DEFAULT_CASH,
        realizedPnl: Number(saved.realizedPnl) || 0,
        orders: Array.isArray(saved.orders) ? saved.orders : [],
        positions: saved.positions && typeof saved.positions === 'object' ? saved.positions : {},
        limits: { ...DEFAULT_LIMITS, ...(saved.limits || {}) },
        killSwitch: Boolean(saved.killSwitch)
      };
    } catch {
      return {
        cash: DEFAULT_CASH,
        startingCash: DEFAULT_CASH,
        realizedPnl: 0,
        orders: [],
        positions: {},
        limits: { ...DEFAULT_LIMITS },
        killSwitch: false
      };
    }
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf8');
  }

  getState(quotes: Record<string, PaperQuote>): {
    mode: 'PAPER_ONLY';
    cash: number;
    startingCash: number;
    realizedPnl: number;
    equity: number;
    unrealizedPnl: number;
    totalPnl: number;
    killSwitch: boolean;
    limits: PaperRiskLimits;
    orders: PaperOrder[];
    positions: PaperPosition[];
  } {
    const positions = Object.entries(this.state.positions).map(([symbol, position]) => {
      const quote = quotes[symbol];
      const marketPrice = quote?.last || quote?.bid || position.averagePrice;
      const marketValue = position.quantity * marketPrice;
      return {
        symbol,
        quantity: position.quantity,
        averagePrice: roundMoney(position.averagePrice),
        marketPrice: roundMoney(marketPrice),
        marketValue: roundMoney(marketValue),
        unrealizedPnl: roundMoney((marketPrice - position.averagePrice) * position.quantity)
      };
    });
    const unrealizedPnl = roundMoney(positions.reduce((sum, position) => sum + position.unrealizedPnl, 0));
    return {
      mode: 'PAPER_ONLY',
      cash: roundMoney(this.state.cash),
      startingCash: roundMoney(this.state.startingCash),
      realizedPnl: roundMoney(this.state.realizedPnl),
      equity: roundMoney(this.state.cash + positions.reduce((sum, position) => sum + position.marketValue, 0)),
      unrealizedPnl,
      totalPnl: roundMoney(this.state.realizedPnl + unrealizedPnl),
      killSwitch: this.state.killSwitch,
      limits: this.state.limits,
      orders: this.state.orders.slice(0, 100),
      positions
    };
  }

  submitOrder(input: {
    symbol: string;
    side: PaperSide;
    type: PaperOrderType;
    quantity: number;
    limitPrice?: number;
    quote?: PaperQuote;
  }): PaperOrder {
    const now = new Date().toISOString();
    const order: PaperOrder = {
      id: `PAPER-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      symbol: input.symbol,
      side: input.side,
      type: input.type,
      quantity: input.quantity,
      limitPrice: input.limitPrice,
      filledQuantity: 0,
      averageFillPrice: 0,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now
    };

    const notional = input.quantity * (input.limitPrice || input.quote?.last || 0);
    const position = this.state.positions[input.symbol]?.quantity || 0;
    const projectedPosition = position + (input.side === 'BUY' ? input.quantity : -input.quantity);
    const reject = (reason: string): PaperOrder => {
      order.status = 'REJECTED';
      order.rejectReason = reason;
      order.updatedAt = new Date().toISOString();
      this.state.orders.unshift(order);
      this.save();
      return order;
    };

    if (this.state.killSwitch) return reject('kill switch is active');
    if (!Number.isInteger(input.quantity) || input.quantity < 1) return reject('quantity must be a positive integer');
    if (input.quantity > this.state.limits.maxOrderQuantity) return reject('quantity exceeds max order quantity');
    if (!validPrice(input.quote?.last) || notional <= 0) return reject('a valid market quote is required');
    if (notional > this.state.limits.maxOrderNotional) return reject('order notional exceeds risk limit');
    if (Math.abs(projectedPosition) > this.state.limits.maxPositionQuantity) return reject('position limit would be exceeded');
    if (this.state.realizedPnl <= -this.state.limits.maxDailyLoss) return reject('daily loss limit has been reached');
    if (input.side === 'BUY' && notional > this.state.cash) return reject('insufficient paper cash');

    const fillPrice = input.side === 'BUY' ? input.quote!.ask : input.quote!.bid;
    const crosses = input.type === 'MARKET' ||
      (input.side === 'BUY' && validPrice(input.limitPrice) && input.limitPrice >= input.quote!.ask) ||
      (input.side === 'SELL' && validPrice(input.limitPrice) && input.limitPrice <= input.quote!.bid);

    if (!crosses) {
      this.state.orders.unshift(order);
      this.save();
      return order;
    }

    order.status = 'FILLED';
    order.filledQuantity = input.quantity;
    order.averageFillPrice = roundMoney(fillPrice);
    order.updatedAt = new Date().toISOString();
    const signedQuantity = input.side === 'BUY' ? input.quantity : -input.quantity;
    const existing = this.state.positions[input.symbol] || { quantity: 0, averagePrice: 0 };
    const newQuantity = existing.quantity + signedQuantity;
    if (existing.quantity !== 0 && Math.sign(existing.quantity) !== Math.sign(signedQuantity)) {
      const closedQuantity = Math.min(Math.abs(existing.quantity), input.quantity);
      this.state.realizedPnl += roundMoney((fillPrice - existing.averagePrice) * closedQuantity * Math.sign(existing.quantity));
    }
    if (newQuantity === 0) {
      delete this.state.positions[input.symbol];
    } else if (existing.quantity === 0 || Math.sign(existing.quantity) === Math.sign(signedQuantity)) {
      const totalQuantity = Math.abs(existing.quantity) + input.quantity;
      this.state.positions[input.symbol] = {
        quantity: newQuantity,
        averagePrice: roundMoney(((Math.abs(existing.quantity) * existing.averagePrice) + (input.quantity * fillPrice)) / totalQuantity)
      };
    } else if (Math.sign(existing.quantity) === Math.sign(newQuantity)) {
      this.state.positions[input.symbol] = {
        quantity: newQuantity,
        averagePrice: existing.averagePrice
      };
    } else {
      this.state.positions[input.symbol] = {
        quantity: newQuantity,
        averagePrice: roundMoney(fillPrice)
      };
    }
    this.state.cash -= signedQuantity * fillPrice;
    this.state.orders.unshift(order);
    this.save();
    return order;
  }

  cancelOrder(id: string): PaperOrder | null {
    const order = this.state.orders.find((candidate) => candidate.id === id);
    if (!order || order.status !== 'OPEN') return null;
    order.status = 'CANCELLED';
    order.updatedAt = new Date().toISOString();
    this.save();
    return order;
  }

  setKillSwitch(active: boolean): void {
    this.state.killSwitch = active;
    if (active) {
      for (const order of this.state.orders) {
        if (order.status === 'OPEN') order.status = 'CANCELLED';
      }
    }
    this.save();
  }

  setLimits(limits: Partial<PaperRiskLimits>): PaperRiskLimits {
    this.state.limits = {
      ...this.state.limits,
      ...Object.fromEntries(Object.entries(limits).filter(([, value]) => Number.isFinite(value) && Number(value) > 0))
    };
    this.save();
    return this.state.limits;
  }

  reset(): void {
    this.state = {
      cash: DEFAULT_CASH,
      startingCash: DEFAULT_CASH,
      realizedPnl: 0,
      orders: [],
      positions: {},
      limits: { ...DEFAULT_LIMITS },
      killSwitch: false
    };
    this.save();
  }
}
