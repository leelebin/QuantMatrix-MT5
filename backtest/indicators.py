"""
技术指标计算模块

纯 Python 实现，无第三方依赖，用于回测引擎中的信号计算。
"""

from __future__ import annotations


def ema(values: list[float], period: int) -> list[float]:
    """计算 EMA (指数移动平均线)

    返回长度与 values 相同的列表，前 period-1 个元素为 None。
    """
    if len(values) < period:
        return [None] * len(values)

    result: list[float | None] = [None] * (period - 1)
    k = 2.0 / (period + 1)

    # 用前 period 个值的 SMA 作为种子
    seed = sum(values[:period]) / period
    result.append(seed)

    for i in range(period, len(values)):
        seed = values[i] * k + seed * (1 - k)
        result.append(seed)

    return result


def sma(values: list[float], period: int) -> list[float]:
    """计算 SMA (简单移动平均线)"""
    if len(values) < period:
        return [None] * len(values)

    result: list[float | None] = [None] * (period - 1)
    window_sum = sum(values[:period])
    result.append(window_sum / period)

    for i in range(period, len(values)):
        window_sum += values[i] - values[i - period]
        result.append(window_sum / period)

    return result


def atr(candles: list[dict], period: int = 14) -> list[float]:
    """计算 ATR (平均真实波幅)

    candles: [{"high": float, "low": float, "close": float}, ...]
    """
    if len(candles) < 2:
        return [None] * len(candles)

    true_ranges: list[float] = [candles[0]["high"] - candles[0]["low"]]
    for i in range(1, len(candles)):
        h = candles[i]["high"]
        l = candles[i]["low"]
        pc = candles[i - 1]["close"]
        tr = max(h - l, abs(h - pc), abs(l - pc))
        true_ranges.append(tr)

    return ema(true_ranges, period)


def crossover(fast: list[float | None], slow: list[float | None]) -> bool:
    """判断最近一根 K 线是否发生金叉 (fast 上穿 slow)"""
    if len(fast) < 2 or len(slow) < 2:
        return False
    f1, f0 = fast[-2], fast[-1]
    s1, s0 = slow[-2], slow[-1]
    if any(v is None for v in (f1, f0, s1, s0)):
        return False
    return f1 <= s1 and f0 > s0


def crossunder(fast: list[float | None], slow: list[float | None]) -> bool:
    """判断最近一根 K 线是否发生死叉 (fast 下穿 slow)"""
    if len(fast) < 2 or len(slow) < 2:
        return False
    f1, f0 = fast[-2], fast[-1]
    s1, s0 = slow[-2], slow[-1]
    if any(v is None for v in (f1, f0, s1, s0)):
        return False
    return f1 >= s1 and f0 < s0
