"""
策略基类

所有回测策略必须继承 BaseStrategy 并实现 on_candle 方法。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Signal(Enum):
    NONE = "NONE"
    BUY = "BUY"
    SELL = "SELL"


@dataclass
class TradeSignal:
    """策略返回的交易信号"""
    signal: Signal = Signal.NONE
    sl: float = 0.0       # 止损价
    tp: float = 0.0       # 止盈价
    reason: str = ""
    meta: dict = field(default_factory=dict)


class BaseStrategy(ABC):
    """回测策略抽象基类

    使用方法:
        class MyStrategy(BaseStrategy):
            def __init__(self):
                super().__init__(name="MyStrategy")

            def on_candle(self, candles, index):
                # candles: 完整历史 K 线列表
                # index:   当前处理到的 K 线下标
                # 返回 TradeSignal
                ...

    策略在 on_candle 中可以访问 candles[0..index] 范围内的所有数据，
    利用 backtest.indicators 模块计算指标，然后决定是否开仓。
    """

    def __init__(self, name: str = "BaseStrategy", warmup: int = 0):
        self.name = name
        self.warmup = warmup  # 策略需要的最少历史 K 线根数

    @abstractmethod
    def on_candle(self, candles: list[dict], index: int) -> TradeSignal:
        """处理第 index 根 K 线，返回交易信号

        Args:
            candles: 完整的历史 K 线数据 (不会被截断)
            index:   当前 K 线索引，策略只应使用 candles[:index+1]

        Returns:
            TradeSignal 实例
        """
        ...
