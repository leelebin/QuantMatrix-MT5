"""
EMA 交叉策略 (Demo)

当 EMA fast 上穿 EMA slow 时做多，下穿时做空。
止损用 ATR 倍数，止盈用风险回报比。
"""

from __future__ import annotations

from backtest import indicators as ind
from backtest.strategies.base import BaseStrategy, Signal, TradeSignal


class EMACrossStrategy(BaseStrategy):
    """EMA 金叉/死叉策略

    参数:
        fast_period: 快线 EMA 周期 (默认 12)
        slow_period: 慢线 EMA 周期 (默认 26)
        atr_period:  ATR 周期 (默认 14)
        sl_atr_mult: 止损 = ATR * sl_atr_mult (默认 1.5)
        rr_ratio:    风险回报比，止盈 = 止损距离 * rr_ratio (默认 2.0)
    """

    def __init__(
        self,
        fast_period: int = 12,
        slow_period: int = 26,
        atr_period: int = 14,
        sl_atr_mult: float = 1.5,
        rr_ratio: float = 2.0,
    ):
        super().__init__(
            name=f"EMACross({fast_period}/{slow_period})",
            warmup=max(slow_period, atr_period) + 2,
        )
        self.fast_period = fast_period
        self.slow_period = slow_period
        self.atr_period = atr_period
        self.sl_atr_mult = sl_atr_mult
        self.rr_ratio = rr_ratio

    def on_candle(self, candles: list[dict], index: int) -> TradeSignal:
        if index < self.warmup:
            return TradeSignal()

        # 取到当前 K 线为止的收盘价
        closes = [c["close"] for c in candles[: index + 1]]

        ema_fast = ind.ema(closes, self.fast_period)
        ema_slow = ind.ema(closes, self.slow_period)

        # 计算 ATR
        atr_values = ind.atr(candles[: index + 1], self.atr_period)
        current_atr = atr_values[-1]
        if current_atr is None or current_atr <= 0:
            return TradeSignal()

        current_price = closes[-1]
        sl_distance = current_atr * self.sl_atr_mult
        tp_distance = sl_distance * self.rr_ratio

        # 金叉 → BUY
        if ind.crossover(ema_fast, ema_slow):
            return TradeSignal(
                signal=Signal.BUY,
                sl=current_price - sl_distance,
                tp=current_price + tp_distance,
                reason=f"EMA{self.fast_period} crossed above EMA{self.slow_period}",
                meta={
                    "ema_fast": ema_fast[-1],
                    "ema_slow": ema_slow[-1],
                    "atr": current_atr,
                },
            )

        # 死叉 → SELL
        if ind.crossunder(ema_fast, ema_slow):
            return TradeSignal(
                signal=Signal.SELL,
                sl=current_price + sl_distance,
                tp=current_price - tp_distance,
                reason=f"EMA{self.fast_period} crossed below EMA{self.slow_period}",
                meta={
                    "ema_fast": ema_fast[-1],
                    "ema_slow": ema_slow[-1],
                    "atr": current_atr,
                },
            )

        return TradeSignal()
