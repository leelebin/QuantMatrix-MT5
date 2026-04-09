"""
QuantMatrix-MT5 Backtesting Engine

Python 回测引擎，通过 mt5_bridge.py 的 getCandles 拉取历史 K 线数据，
支持自定义策略在历史数据上模拟交易，输出胜率、盈亏比、最大回撤、夏普比率等统计指标。
"""

from backtest.engine import BacktestEngine
from backtest.strategies.base import BaseStrategy
from backtest.strategies.ema_cross import EMACrossStrategy

__all__ = ["BacktestEngine", "BaseStrategy", "EMACrossStrategy"]
