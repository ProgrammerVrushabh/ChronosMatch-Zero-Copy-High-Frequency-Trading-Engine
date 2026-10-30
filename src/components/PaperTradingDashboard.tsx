import React, { useEffect, useState } from 'react';
import { AlertTriangle, Play, RefreshCw, ShieldCheck, Square, TrendingDown, TrendingUp } from 'lucide-react';
import { apiUrl } from '../api';

interface PaperState {
  cash: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  killSwitch: boolean;
  quote: { symbol: string; bid: number; ask: number; last: number } | null;
  limits: { maxOrderQuantity: number; maxOrderNotional: number; maxPositionQuantity: number; maxDailyLoss: number };
  orders: Array<{ id: string; symbol: string; side: string; type: string; quantity: number; filledQuantity: number; averageFillPrice: number; status: string; rejectReason?: string }>;
  positions: Array<{ symbol: string; quantity: number; averagePrice: number; marketPrice: number; marketValue: number; unrealizedPnl: number }>;
}

const money = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const PaperTradingDashboard: React.FC = () => {
  const [state, setState] = useState<PaperState | null>(null);
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [quantity, setQuantity] = useState(100);
  const [limitPrice, setLimitPrice] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const load = async () => {
    const response = await fetch(apiUrl('/api/paper/state'));
    if (!response.ok) throw new Error('Unable to load paper account');
    setState(await response.json());
  };

  useEffect(() => {
    load().catch((error) => setMessage(error.message));
    const timer = setInterval(() => load().catch(() => undefined), 2500);
    return () => clearInterval(timer);
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch(apiUrl('/api/paper/orders'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: state?.quote?.symbol || 'NVDA',
          side,
          type,
          quantity,
          limitPrice: type === 'LIMIT' ? Number(limitPrice) : undefined
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.order?.rejectReason || data.error || 'Order rejected');
      setMessage(`${data.order.status}: ${data.order.id}`);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Order failed');
    } finally {
      setLoading(false);
    }
  };

  const toggleKillSwitch = async () => {
    await fetch(apiUrl('/api/paper/controls'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ killSwitch: !state?.killSwitch })
    });
    await load();
  };

  const reset = async () => {
    if (!window.confirm('Reset the paper account, positions, and order history?')) return;
    await fetch(apiUrl('/api/paper/reset'), { method: 'POST' });
    await load();
    setMessage('Paper account reset to $100,000');
  };

  if (!state) return <div className="p-6 text-sm text-[#8ca0b4]">Loading paper account...</div>;

  return (
    <div className="space-y-4 font-mono">
      <div className="rounded-xl border border-emerald-700/50 bg-[#14231d] p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-emerald-300">
              <ShieldCheck className="h-5 w-5" /> PAPER TRADING CONTROL PLANE
            </div>
            <p className="mt-1 text-[11px] text-emerald-100/70">Simulation only. Orders never reach a broker or the live matching engine.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={toggleKillSwitch} className={`flex items-center gap-1 rounded border px-3 py-2 text-xs font-bold ${state.killSwitch ? 'border-red-500 bg-red-950 text-red-200' : 'border-amber-600 bg-amber-950/40 text-amber-200'}`}>
              {state.killSwitch ? <Play className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
              {state.killSwitch ? 'RESUME ORDERS' : 'KILL SWITCH'}
            </button>
            <button onClick={reset} className="flex items-center gap-1 rounded border border-[#3b455c] bg-[#131722] px-3 py-2 text-xs text-slate-200"><RefreshCw className="h-3.5 w-3.5" /> RESET</button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ['Cash', money(state.cash)],
          ['Equity', money(state.equity)],
          ['Realized P&L', money(state.realizedPnl)],
          ['Unrealized P&L', money(state.unrealizedPnl)],
          ['Total P&L', money(state.totalPnl)]
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-[#2a2e39] bg-[#1c2030] p-3">
            <div className="text-[10px] uppercase text-[#64748b]">{label}</div>
            <div className={`mt-1 text-sm font-bold ${label.includes('P&L') ? (Number(value.replace(/[$,]/g, '')) >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-100'}`}>{value}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <form onSubmit={submit} className="rounded-lg border border-[#2a2e39] bg-[#1c2030] p-4 lg:col-span-2">
          <div className="mb-3 flex items-center justify-between"><h3 className="text-xs font-bold text-slate-100">SUBMIT PAPER ORDER</h3><span className="text-[10px] text-[#7da98f]">{state.quote?.symbol || 'NVDA'} {state.quote ? `${state.quote.bid.toFixed(2)} / ${state.quote.ask.toFixed(2)}` : 'NO QUOTE'}</span></div>
          <div className="grid grid-cols-2 gap-2">
            <select value={side} onChange={(e) => setSide(e.target.value as 'BUY' | 'SELL')} className="rounded border border-[#3b455c] bg-[#131722] p-2 text-xs text-slate-200"><option>BUY</option><option>SELL</option></select>
            <select value={type} onChange={(e) => setType(e.target.value as 'MARKET' | 'LIMIT')} className="rounded border border-[#3b455c] bg-[#131722] p-2 text-xs text-slate-200"><option>MARKET</option><option>LIMIT</option></select>
            <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} className="rounded border border-[#3b455c] bg-[#131722] p-2 text-xs text-slate-200" placeholder="Quantity" />
            {type === 'LIMIT' && <input type="number" min="0.01" step="0.01" value={limitPrice} onChange={(e) => setLimitPrice(e.target.value)} className="rounded border border-[#3b455c] bg-[#131722] p-2 text-xs text-slate-200" placeholder="Limit price" />}
          </div>
          <button disabled={loading || state.killSwitch} className="mt-3 flex w-full items-center justify-center gap-2 rounded bg-emerald-600 px-3 py-2 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"><TrendingUp className="h-3.5 w-3.5" /> {state.killSwitch ? 'KILL SWITCH ACTIVE' : 'SUBMIT PAPER ORDER'}</button>
          {message && <div className="mt-3 flex items-start gap-2 text-[11px] text-amber-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{message}</div>}
          <div className="mt-4 border-t border-[#2a2e39] pt-3 text-[10px] text-[#64748b]">Limits: {state.limits.maxOrderQuantity.toLocaleString()} shares / {money(state.limits.maxOrderNotional)} notional / {state.limits.maxPositionQuantity.toLocaleString()} position</div>
        </form>

        <div className="rounded-lg border border-[#2a2e39] bg-[#1c2030] p-4 lg:col-span-3">
          <h3 className="mb-3 text-xs font-bold text-slate-100">POSITIONS</h3>
          {state.positions.length === 0 ? <div className="py-8 text-center text-xs text-[#64748b]">No open paper positions.</div> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-[10px] uppercase text-[#64748b]"><tr><th className="pb-2">Symbol</th><th className="pb-2">Qty</th><th className="pb-2">Avg</th><th className="pb-2">Mark</th><th className="pb-2">P&L</th></tr></thead><tbody className="divide-y divide-[#2a2e39]">{state.positions.map((position) => <tr key={position.symbol}><td className="py-2 font-bold text-slate-200">{position.symbol}</td><td className="py-2 text-slate-300">{position.quantity}</td><td className="py-2 text-slate-300">{money(position.averagePrice)}</td><td className="py-2 text-slate-300">{money(position.marketPrice)}</td><td className={`py-2 font-bold ${position.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{position.unrealizedPnl >= 0 ? <TrendingUp className="mr-1 inline h-3 w-3" /> : <TrendingDown className="mr-1 inline h-3 w-3" />}{money(position.unrealizedPnl)}</td></tr>)}</tbody></table></div>}
        </div>
      </div>

      <div className="rounded-lg border border-[#2a2e39] bg-[#1c2030] p-4">
        <h3 className="mb-3 text-xs font-bold text-slate-100">RECENT PAPER ORDERS</h3>
        <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-[10px] uppercase text-[#64748b]"><tr><th className="pb-2">ID</th><th className="pb-2">Side</th><th className="pb-2">Qty</th><th className="pb-2">Fill</th><th className="pb-2">Status</th></tr></thead><tbody className="divide-y divide-[#2a2e39]">{state.orders.slice(0, 10).map((order) => <tr key={order.id}><td className="py-2 text-[#8ca0b4]">{order.id}</td><td className={`py-2 font-bold ${order.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>{order.side}</td><td className="py-2 text-slate-300">{order.quantity}</td><td className="py-2 text-slate-300">{order.averageFillPrice ? money(order.averageFillPrice) : '-'}</td><td className={`py-2 font-bold ${order.status === 'REJECTED' ? 'text-red-400' : order.status === 'FILLED' ? 'text-emerald-400' : 'text-amber-300'}`}>{order.status}{order.rejectReason ? `: ${order.rejectReason}` : ''}</td></tr>)}</tbody></table></div>
      </div>
    </div>
  );
};
