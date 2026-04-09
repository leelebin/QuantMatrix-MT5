"""
数据加载模块

支持两种数据源:
1. MT5 实时连接 — 通过 mt5_bridge.py 的 getCandles 拉取历史 K 线
2. CSV 文件 — 离线回测，无需 MT5 环境
"""

from __future__ import annotations

import csv
import json
import subprocess
import sys
from pathlib import Path
from typing import Optional

# mt5_bridge.py 所在路径
_BRIDGE_PATH = Path(__file__).resolve().parent.parent / "mt5_bridge.py"


class DataLoader:
    """历史 K 线数据加载器"""

    @staticmethod
    def from_mt5(
        symbol: str,
        timeframe: str = "1h",
        limit: int = 1000,
        start_time: Optional[str] = None,
        *,
        mt5_login: int = 0,
        mt5_password: str = "",
        mt5_server: str = "",
        mt5_path: Optional[str] = None,
    ) -> list[dict]:
        """通过 mt5_bridge.py 从 MT5 拉取历史 K 线

        需要本机安装 MetaTrader5 并提供登录凭证。
        内部启动 mt5_bridge.py 子进程，发送 connect → getCandles → disconnect 命令序列。

        Args:
            symbol:       交易品种 (如 "EURUSD")
            timeframe:    K 线周期 ("1m","5m","15m","30m","1h","4h","1d" 等)
            limit:        获取 K 线根数
            start_time:   起始时间 (ISO 格式或毫秒时间戳)
            mt5_login:    MT5 账号
            mt5_password: MT5 密码
            mt5_server:   MT5 服务器
            mt5_path:     MT5 终端路径 (可选)

        Returns:
            K 线字典列表 [{"time", "open", "high", "low", "close", "tickVolume", "spread", "volume"}, ...]
        """
        if not _BRIDGE_PATH.exists():
            raise FileNotFoundError(f"mt5_bridge.py not found at {_BRIDGE_PATH}")

        proc = subprocess.Popen(
            [sys.executable, str(_BRIDGE_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        def _send(cmd: dict) -> dict:
            line = json.dumps(cmd) + "\n"
            proc.stdin.write(line)
            proc.stdin.flush()
            resp_line = proc.stdout.readline()
            if not resp_line:
                raise RuntimeError("mt5_bridge.py 未返回响应")
            return json.loads(resp_line)

        try:
            # 等待 ready 信号
            ready = json.loads(proc.stdout.readline())
            if not ready.get("success"):
                raise RuntimeError(f"mt5_bridge.py 启动失败: {ready.get('error')}")

            # 连接 MT5
            connect_params = {
                "login": mt5_login,
                "password": mt5_password,
                "server": mt5_server,
            }
            if mt5_path:
                connect_params["path"] = mt5_path

            resp = _send({"id": "1", "method": "connect", "params": connect_params})
            if not resp.get("success"):
                raise RuntimeError(f"MT5 连接失败: {resp.get('error')}")

            # 获取 K 线
            candle_params = {
                "symbol": symbol,
                "timeframe": timeframe,
                "limit": limit,
            }
            if start_time:
                candle_params["startTime"] = start_time

            resp = _send({"id": "2", "method": "getCandles", "params": candle_params})
            if not resp.get("success"):
                raise RuntimeError(f"获取 K 线失败: {resp.get('error')}")

            candles = resp["result"]

            # 断开
            _send({"id": "3", "method": "disconnect", "params": {}})

            return candles

        finally:
            proc.stdin.close()
            proc.terminate()
            proc.wait(timeout=5)

    @staticmethod
    def from_csv(filepath: str, time_col: str = "time") -> list[dict]:
        """从 CSV 文件加载 K 线数据

        CSV 至少需要 time, open, high, low, close 列。

        Args:
            filepath: CSV 文件路径
            time_col: 时间列名 (默认 "time")

        Returns:
            K 线字典列表
        """
        candles = []
        with open(filepath, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                candles.append({
                    "time": row[time_col],
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "tickVolume": int(row.get("tickVolume", row.get("tick_volume", 0))),
                    "spread": int(row.get("spread", 0)),
                    "volume": int(row.get("volume", 0)),
                })
        return candles

    @staticmethod
    def generate_sample(
        n: int = 2000,
        start_price: float = 1.1000,
        volatility: float = 0.0005,
        seed: int = 42,
    ) -> list[dict]:
        """生成模拟 K 线数据用于 demo / 测试

        使用几何布朗运动模拟价格，带有趋势和均值回归成分。

        Args:
            n:           K 线根数
            start_price: 起始价格
            volatility:  每根 K 线的波动率标准差
            seed:        随机种子

        Returns:
            K 线字典列表
        """
        import math
        import random
        from datetime import datetime, timedelta, timezone

        random.seed(seed)
        candles = []
        price = start_price
        base_time = datetime(2024, 1, 1, tzinfo=timezone.utc)

        for i in range(n):
            # 带有轻微均值回归的随机游走
            drift = -0.1 * (price - start_price) / start_price  # 均值回归
            ret = drift * volatility + random.gauss(0, volatility)
            price *= (1 + ret)

            # 生成 OHLC
            intra_vol = volatility * price
            o = price * (1 + random.gauss(0, 0.0001))
            h = max(o, price) + abs(random.gauss(0, intra_vol))
            l = min(o, price) - abs(random.gauss(0, intra_vol))
            c = price

            candles.append({
                "time": (base_time + timedelta(hours=i)).isoformat(),
                "open": round(o, 5),
                "high": round(h, 5),
                "low": round(l, 5),
                "close": round(c, 5),
                "tickVolume": random.randint(100, 5000),
                "spread": random.randint(1, 5),
                "volume": random.randint(50, 3000),
            })

        return candles
