"""
回测引擎核心模块

BacktestEngine 接收历史 K 线数据和策略实例，逐根 K 线驱动策略，
模拟开仓 / 止损 / 止盈 / 平仓流程，最终输出完整的统计报告。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from backtest.strategies.base import BaseStrategy, Signal


# ──────────────────────────── 数据结构 ────────────────────────────

@dataclass
class Trade:
    """已平仓交易记录"""
    id: int
    direction: str          # "BUY" / "SELL"
    entry_price: float
    entry_time: str
    exit_price: float
    exit_time: str
    sl: float
    tp: float
    lot_size: float
    profit_loss: float      # 净盈亏金额
    profit_pips: float      # 盈亏点数
    exit_reason: str        # "SL_HIT" / "TP_HIT" / "SIGNAL_REVERSE" / "END_OF_DATA"
    signal_reason: str      # 策略给出的开仓理由


@dataclass
class BacktestResult:
    """回测结果"""
    symbol: str
    strategy: str
    timeframe: str
    period_start: str
    period_end: str
    initial_balance: float
    final_balance: float

    # 核心统计
    total_trades: int
    winning_trades: int
    losing_trades: int
    win_rate: float                 # 胜率 (0-1)
    profit_loss_ratio: float        # 盈亏比 (平均盈利/平均亏损)
    profit_factor: float            # 利润因子 (总盈利/总亏损)
    max_drawdown_pct: float         # 最大回撤 (%)
    sharpe_ratio: float             # 夏普比率 (年化)

    # 详细统计
    net_profit: float
    return_pct: float
    avg_win: float
    avg_loss: float
    max_consecutive_wins: int
    max_consecutive_losses: int
    total_profit_pips: float
    total_loss_pips: float
    avg_holding_bars: float

    # 逐笔交易
    trades: list[Trade] = field(default_factory=list)
    # 权益曲线
    equity_curve: list[dict] = field(default_factory=list)

    def summary_text(self) -> str:
        """格式化输出统计摘要"""
        lines = [
            "=" * 60,
            f"  回测报告: {self.strategy}  |  {self.symbol}  |  {self.timeframe}",
            "=" * 60,
            f"  回测区间:     {self.period_start[:10]} → {self.period_end[:10]}",
            f"  初始资金:     {self.initial_balance:,.2f}",
            f"  最终资金:     {self.final_balance:,.2f}",
            f"  净利润:       {self.net_profit:,.2f}  ({self.return_pct:+.2f}%)",
            "-" * 60,
            f"  总交易数:     {self.total_trades}",
            f"  盈利交易:     {self.winning_trades}",
            f"  亏损交易:     {self.losing_trades}",
            f"  胜率:         {self.win_rate * 100:.1f}%",
            f"  盈亏比:       {self.profit_loss_ratio:.2f}",
            f"  利润因子:     {self.profit_factor:.2f}",
            f"  最大回撤:     {self.max_drawdown_pct:.2f}%",
            f"  夏普比率:     {self.sharpe_ratio:.2f}",
            "-" * 60,
            f"  平均盈利:     {self.avg_win:,.2f}",
            f"  平均亏损:     {self.avg_loss:,.2f}",
            f"  最大连胜:     {self.max_consecutive_wins}",
            f"  最大连亏:     {self.max_consecutive_losses}",
            f"  平均持仓K线:  {self.avg_holding_bars:.1f}",
            "=" * 60,
        ]
        return "\n".join(lines)

    def to_dict(self) -> dict:
        """转为可序列化的字典"""
        d = {
            "symbol": self.symbol,
            "strategy": self.strategy,
            "timeframe": self.timeframe,
            "period": {"start": self.period_start, "end": self.period_end},
            "initial_balance": self.initial_balance,
            "final_balance": self.final_balance,
            "summary": {
                "total_trades": self.total_trades,
                "winning_trades": self.winning_trades,
                "losing_trades": self.losing_trades,
                "win_rate": self.win_rate,
                "profit_loss_ratio": self.profit_loss_ratio,
                "profit_factor": self.profit_factor,
                "max_drawdown_pct": self.max_drawdown_pct,
                "sharpe_ratio": self.sharpe_ratio,
                "net_profit": self.net_profit,
                "return_pct": self.return_pct,
                "avg_win": self.avg_win,
                "avg_loss": self.avg_loss,
                "max_consecutive_wins": self.max_consecutive_wins,
                "max_consecutive_losses": self.max_consecutive_losses,
                "avg_holding_bars": self.avg_holding_bars,
            },
            "trades": [
                {
                    "id": t.id,
                    "direction": t.direction,
                    "entry_price": t.entry_price,
                    "entry_time": t.entry_time,
                    "exit_price": t.exit_price,
                    "exit_time": t.exit_time,
                    "profit_loss": t.profit_loss,
                    "profit_pips": t.profit_pips,
                    "exit_reason": t.exit_reason,
                    "signal_reason": t.signal_reason,
                }
                for t in self.trades
            ],
            "equity_curve": self.equity_curve,
        }
        return d

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, ensure_ascii=False)


# ──────────────────────────── 持仓状态 ────────────────────────────

@dataclass
class _Position:
    id: int
    direction: str
    entry_price: float
    entry_time: str
    entry_index: int
    sl: float
    tp: float
    lot_size: float
    reason: str


# ──────────────────────────── 引擎 ────────────────────────────

class BacktestEngine:
    """回测引擎

    用法:
        engine = BacktestEngine(
            initial_balance=10000,
            pip_size=0.0001,          # EURUSD 的点大小
            contract_size=100000,     # 标准手合约大小
            spread_pips=1.5,          # 点差
            risk_per_trade=0.02,      # 每笔交易风险 2%
        )
        result = engine.run(candles, strategy, symbol="EURUSD", timeframe="1h")
        print(result.summary_text())
    """

    def __init__(
        self,
        initial_balance: float = 10000.0,
        pip_size: float = 0.0001,
        contract_size: float = 100000.0,
        spread_pips: float = 1.5,
        slippage_pips: float = 0.5,
        risk_per_trade: float = 0.02,
        max_lot: float = 5.0,
        min_lot: float = 0.01,
        lot_step: float = 0.01,
    ):
        self.initial_balance = initial_balance
        self.pip_size = pip_size
        self.contract_size = contract_size
        self.spread = spread_pips * pip_size
        self.slippage = slippage_pips * pip_size
        self.risk_per_trade = risk_per_trade
        self.max_lot = max_lot
        self.min_lot = min_lot
        self.lot_step = lot_step

    def run(
        self,
        candles: list[dict],
        strategy: BaseStrategy,
        symbol: str = "UNKNOWN",
        timeframe: str = "1h",
    ) -> BacktestResult:
        """执行回测

        Args:
            candles:   K 线数据列表 [{"time","open","high","low","close",...}, ...]
            strategy:  策略实例 (继承自 BaseStrategy)
            symbol:    交易品种名称 (仅用于报告)
            timeframe: K 线周期 (仅用于报告)

        Returns:
            BacktestResult 包含完整统计和逐笔交易记录
        """
        if len(candles) < strategy.warmup + 10:
            raise ValueError(
                f"K 线数据不足: 需要至少 {strategy.warmup + 10} 根, 实际 {len(candles)} 根"
            )

        balance = self.initial_balance
        peak_balance = self.initial_balance
        trades: list[Trade] = []
        equity_curve: list[dict] = [{"time": candles[0]["time"], "equity": balance}]
        position: Optional[_Position] = None
        trade_counter = 0

        for i in range(len(candles)):
            candle = candles[i]

            # ── 1. 检查持仓是否触发止损/止盈 ──
            if position is not None:
                hit = self._check_sl_tp(position, candle)
                if hit is not None:
                    exit_price, exit_reason = hit
                    trade = self._close_position(position, exit_price, candle["time"], exit_reason)
                    balance += trade.profit_loss
                    trades.append(trade)
                    position = None
                    if balance > peak_balance:
                        peak_balance = balance

            # ── 2. 获取策略信号 ──
            signal = strategy.on_candle(candles, i)

            if signal.signal == Signal.NONE:
                pass
            elif position is None:
                # 无持仓 → 开仓
                if signal.signal in (Signal.BUY, Signal.SELL):
                    direction = signal.signal.value
                    entry_price = self._apply_entry_cost(candle["close"], direction)
                    lot_size = self._calc_lot_size(balance, entry_price, signal.sl)
                    if lot_size >= self.min_lot:
                        trade_counter += 1
                        position = _Position(
                            id=trade_counter,
                            direction=direction,
                            entry_price=entry_price,
                            entry_time=candle["time"],
                            entry_index=i,
                            sl=signal.sl,
                            tp=signal.tp,
                            lot_size=lot_size,
                            reason=signal.reason,
                        )
            else:
                # 有持仓 → 如果信号反向则平仓反手
                if (
                    (position.direction == "BUY" and signal.signal == Signal.SELL)
                    or (position.direction == "SELL" and signal.signal == Signal.BUY)
                ):
                    exit_price = self._apply_exit_cost(candle["close"], position.direction)
                    trade = self._close_position(position, exit_price, candle["time"], "SIGNAL_REVERSE")
                    balance += trade.profit_loss
                    trades.append(trade)
                    if balance > peak_balance:
                        peak_balance = balance

                    # 反手开仓
                    direction = signal.signal.value
                    entry_price = self._apply_entry_cost(candle["close"], direction)
                    lot_size = self._calc_lot_size(balance, entry_price, signal.sl)
                    if lot_size >= self.min_lot:
                        trade_counter += 1
                        position = _Position(
                            id=trade_counter,
                            direction=direction,
                            entry_price=entry_price,
                            entry_time=candle["time"],
                            entry_index=i,
                            sl=signal.sl,
                            tp=signal.tp,
                            lot_size=lot_size,
                            reason=signal.reason,
                        )
                    else:
                        position = None

            # ── 3. 记录权益曲线 (每 10 根 K 线采样一次) ──
            if i % 10 == 0 or i == len(candles) - 1:
                equity = balance
                if position is not None:
                    mtm = self._mark_to_market(position, candle["close"])
                    equity += mtm
                equity_curve.append({"time": candle["time"], "equity": round(equity, 2)})

        # ── 4. 结束时平仓 ──
        if position is not None:
            last_candle = candles[-1]
            exit_price = self._apply_exit_cost(last_candle["close"], position.direction)
            trade = self._close_position(position, exit_price, last_candle["time"], "END_OF_DATA")
            balance += trade.profit_loss
            trades.append(trade)

        # ── 5. 计算统计指标 ──
        return self._build_result(
            trades=trades,
            equity_curve=equity_curve,
            balance=balance,
            candles=candles,
            strategy=strategy,
            symbol=symbol,
            timeframe=timeframe,
        )

    # ──────────────────── 内部方法 ────────────────────

    def _apply_entry_cost(self, price: float, direction: str) -> float:
        if direction == "BUY":
            return price + self.spread / 2 + self.slippage
        else:
            return price - self.spread / 2 - self.slippage

    def _apply_exit_cost(self, price: float, direction: str) -> float:
        if direction == "BUY":
            return price - self.spread / 2 - self.slippage
        else:
            return price + self.spread / 2 + self.slippage

    def _calc_lot_size(self, balance: float, entry_price: float, sl: float) -> float:
        sl_distance = abs(entry_price - sl)
        if sl_distance <= 0:
            return self.min_lot

        sl_pips = sl_distance / self.pip_size
        pip_value = self.pip_size * self.contract_size  # 每手每点价值
        risk_amount = balance * self.risk_per_trade
        lot_size = risk_amount / (sl_pips * pip_value)

        # 按 lot_step 取整
        lot_size = math.floor(lot_size / self.lot_step) * self.lot_step
        lot_size = max(self.min_lot, min(lot_size, self.max_lot))
        return round(lot_size, 2)

    def _check_sl_tp(self, pos: _Position, candle: dict) -> Optional[tuple[float, str]]:
        if pos.direction == "BUY":
            if candle["low"] <= pos.sl:
                return (pos.sl, "SL_HIT")
            if candle["high"] >= pos.tp:
                return (pos.tp, "TP_HIT")
        else:
            if candle["high"] >= pos.sl:
                return (pos.sl, "SL_HIT")
            if candle["low"] <= pos.tp:
                return (pos.tp, "TP_HIT")
        return None

    def _mark_to_market(self, pos: _Position, current_price: float) -> float:
        if pos.direction == "BUY":
            price_diff = current_price - pos.entry_price
        else:
            price_diff = pos.entry_price - current_price
        return price_diff * pos.lot_size * self.contract_size

    def _close_position(
        self, pos: _Position, exit_price: float, exit_time: str, reason: str
    ) -> Trade:
        if pos.direction == "BUY":
            price_diff = exit_price - pos.entry_price
        else:
            price_diff = pos.entry_price - exit_price

        profit_pips = round(price_diff / self.pip_size, 1)
        profit_loss = round(price_diff * pos.lot_size * self.contract_size, 2)

        return Trade(
            id=pos.id,
            direction=pos.direction,
            entry_price=pos.entry_price,
            entry_time=pos.entry_time,
            exit_price=exit_price,
            exit_time=exit_time,
            sl=pos.sl,
            tp=pos.tp,
            lot_size=pos.lot_size,
            profit_loss=profit_loss,
            profit_pips=profit_pips,
            exit_reason=reason,
            signal_reason=pos.reason,
        )

    def _build_result(
        self,
        trades: list[Trade],
        equity_curve: list[dict],
        balance: float,
        candles: list[dict],
        strategy: BaseStrategy,
        symbol: str,
        timeframe: str,
    ) -> BacktestResult:
        if not trades:
            return BacktestResult(
                symbol=symbol,
                strategy=strategy.name,
                timeframe=timeframe,
                period_start=candles[0]["time"],
                period_end=candles[-1]["time"],
                initial_balance=self.initial_balance,
                final_balance=balance,
                total_trades=0,
                winning_trades=0,
                losing_trades=0,
                win_rate=0.0,
                profit_loss_ratio=0.0,
                profit_factor=0.0,
                max_drawdown_pct=0.0,
                sharpe_ratio=0.0,
                net_profit=0.0,
                return_pct=0.0,
                avg_win=0.0,
                avg_loss=0.0,
                max_consecutive_wins=0,
                max_consecutive_losses=0,
                total_profit_pips=0.0,
                total_loss_pips=0.0,
                avg_holding_bars=0.0,
                trades=[],
                equity_curve=equity_curve,
            )

        winners = [t for t in trades if t.profit_loss > 0]
        losers = [t for t in trades if t.profit_loss <= 0]

        total_win_amount = sum(t.profit_loss for t in winners)
        total_loss_amount = sum(abs(t.profit_loss) for t in losers)
        total_profit_pips = sum(t.profit_pips for t in winners)
        total_loss_pips = sum(t.profit_pips for t in losers)

        avg_win = total_win_amount / len(winners) if winners else 0.0
        avg_loss = total_loss_amount / len(losers) if losers else 0.0

        # 盈亏比
        profit_loss_ratio = avg_win / avg_loss if avg_loss > 0 else (999.0 if avg_win > 0 else 0.0)

        # 利润因子
        profit_factor = (
            total_win_amount / total_loss_amount
            if total_loss_amount > 0
            else (999.0 if total_win_amount > 0 else 0.0)
        )

        # 最大连胜/连亏
        max_cons_wins = 0
        max_cons_losses = 0
        cons_wins = 0
        cons_losses = 0
        for t in trades:
            if t.profit_loss > 0:
                cons_wins += 1
                cons_losses = 0
            else:
                cons_losses += 1
                cons_wins = 0
            max_cons_wins = max(max_cons_wins, cons_wins)
            max_cons_losses = max(max_cons_losses, cons_losses)

        # 最大回撤
        peak = self.initial_balance
        max_dd = 0.0
        running = self.initial_balance
        for t in trades:
            running += t.profit_loss
            if running > peak:
                peak = running
            dd = (peak - running) / peak if peak > 0 else 0
            max_dd = max(max_dd, dd)

        # 夏普比率 (年化，假设每笔交易为独立期间)
        returns = [t.profit_loss / self.initial_balance for t in trades]
        avg_ret = sum(returns) / len(returns)
        std_ret = math.sqrt(sum((r - avg_ret) ** 2 for r in returns) / len(returns))
        sharpe = (avg_ret / std_ret) * math.sqrt(252) if std_ret > 0 else 0.0

        # 平均持仓 K 线数 (简化: 通过时间戳索引差计算不可行，用交易间时间差)
        # 这里用一个简单方法: 找 entry/exit 在 candles 中的索引
        total_bars = 0
        bar_count = 0
        time_to_idx = {c["time"]: idx for idx, c in enumerate(candles)}
        for t in trades:
            entry_idx = time_to_idx.get(t.entry_time)
            exit_idx = time_to_idx.get(t.exit_time)
            if entry_idx is not None and exit_idx is not None:
                total_bars += exit_idx - entry_idx
                bar_count += 1
        avg_holding_bars = total_bars / bar_count if bar_count > 0 else 0.0

        net_profit = balance - self.initial_balance
        return_pct = (net_profit / self.initial_balance) * 100

        return BacktestResult(
            symbol=symbol,
            strategy=strategy.name,
            timeframe=timeframe,
            period_start=candles[0]["time"],
            period_end=candles[-1]["time"],
            initial_balance=self.initial_balance,
            final_balance=round(balance, 2),
            total_trades=len(trades),
            winning_trades=len(winners),
            losing_trades=len(losers),
            win_rate=round(len(winners) / len(trades), 4),
            profit_loss_ratio=round(profit_loss_ratio, 2),
            profit_factor=round(profit_factor, 2),
            max_drawdown_pct=round(max_dd * 100, 2),
            sharpe_ratio=round(sharpe, 2),
            net_profit=round(net_profit, 2),
            return_pct=round(return_pct, 2),
            avg_win=round(avg_win, 2),
            avg_loss=round(avg_loss, 2),
            max_consecutive_wins=max_cons_wins,
            max_consecutive_losses=max_cons_losses,
            total_profit_pips=round(total_profit_pips, 1),
            total_loss_pips=round(total_loss_pips, 1),
            avg_holding_bars=round(avg_holding_bars, 1),
            trades=trades,
            equity_curve=equity_curve,
        )
