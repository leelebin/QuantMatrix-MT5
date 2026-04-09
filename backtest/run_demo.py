#!/usr/bin/env python3
"""
回测引擎 Demo

使用生成的模拟数据运行 EMA 交叉策略回测，演示完整流程。

用法:
    # 使用模拟数据 (无需 MT5)
    python -m backtest.run_demo

    # 使用 MT5 实时数据
    python -m backtest.run_demo --mt5 --symbol EURUSD --timeframe 1h --limit 2000 \
        --login 12345 --password xxx --server BrokerServer

    # 使用 CSV 文件
    python -m backtest.run_demo --csv data/EURUSD_H1.csv --symbol EURUSD

    # 自定义策略参数
    python -m backtest.run_demo --fast 10 --slow 30 --atr-mult 2.0 --rr 2.5

    # 输出 JSON 结果到文件
    python -m backtest.run_demo --output result.json
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# 确保项目根目录在 sys.path 中
_project_root = str(Path(__file__).resolve().parent.parent)
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from backtest.data_loader import DataLoader
from backtest.engine import BacktestEngine
from backtest.strategies.ema_cross import EMACrossStrategy


def main():
    parser = argparse.ArgumentParser(
        description="QuantMatrix-MT5 回测引擎 Demo (EMA 交叉策略)"
    )

    # 数据源
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--mt5", action="store_true", help="从 MT5 拉取实时数据")
    source.add_argument("--csv", type=str, help="从 CSV 文件加载数据")

    # MT5 连接参数
    parser.add_argument("--login", type=int, default=0, help="MT5 账号")
    parser.add_argument("--password", type=str, default="", help="MT5 密码")
    parser.add_argument("--server", type=str, default="", help="MT5 服务器")
    parser.add_argument("--mt5-path", type=str, default=None, help="MT5 终端路径")

    # 品种与周期
    parser.add_argument("--symbol", type=str, default="EURUSD", help="交易品种 (默认 EURUSD)")
    parser.add_argument("--timeframe", type=str, default="1h", help="K 线周期 (默认 1h)")
    parser.add_argument("--limit", type=int, default=2000, help="K 线根数 (默认 2000)")

    # 策略参数
    parser.add_argument("--fast", type=int, default=12, help="快线 EMA 周期 (默认 12)")
    parser.add_argument("--slow", type=int, default=26, help="慢线 EMA 周期 (默认 26)")
    parser.add_argument("--atr-period", type=int, default=14, help="ATR 周期 (默认 14)")
    parser.add_argument("--atr-mult", type=float, default=1.5, help="止损 ATR 倍数 (默认 1.5)")
    parser.add_argument("--rr", type=float, default=2.0, help="风险回报比 (默认 2.0)")

    # 引擎参数
    parser.add_argument("--balance", type=float, default=10000.0, help="初始资金 (默认 10000)")
    parser.add_argument("--pip-size", type=float, default=0.0001, help="点大小 (默认 0.0001)")
    parser.add_argument("--contract-size", type=float, default=100000.0, help="合约大小 (默认 100000)")
    parser.add_argument("--spread", type=float, default=1.5, help="点差 pips (默认 1.5)")
    parser.add_argument("--risk", type=float, default=0.02, help="每笔风险比例 (默认 0.02)")

    # 输出
    parser.add_argument("--output", "-o", type=str, default=None, help="JSON 结果输出文件路径")
    parser.add_argument("--trades", action="store_true", help="打印逐笔交易明细")

    args = parser.parse_args()

    # ── 1. 加载数据 ──
    print(f"[数据] 加载中...")
    if args.mt5:
        candles = DataLoader.from_mt5(
            symbol=args.symbol,
            timeframe=args.timeframe,
            limit=args.limit,
            mt5_login=args.login,
            mt5_password=args.password,
            mt5_server=args.server,
            mt5_path=args.mt5_path,
        )
        print(f"[数据] 从 MT5 获取 {len(candles)} 根 {args.symbol} {args.timeframe} K 线")
    elif args.csv:
        candles = DataLoader.from_csv(args.csv)
        print(f"[数据] 从 CSV 加载 {len(candles)} 根 K 线")
    else:
        candles = DataLoader.generate_sample(n=args.limit, seed=42)
        print(f"[数据] 生成 {len(candles)} 根模拟 K 线 (demo 模式)")

    # ── 2. 创建策略 ──
    strategy = EMACrossStrategy(
        fast_period=args.fast,
        slow_period=args.slow,
        atr_period=args.atr_period,
        sl_atr_mult=args.atr_mult,
        rr_ratio=args.rr,
    )
    print(f"[策略] {strategy.name}, SL={args.atr_mult}×ATR, RR=1:{args.rr}")

    # ── 3. 创建引擎并运行 ──
    engine = BacktestEngine(
        initial_balance=args.balance,
        pip_size=args.pip_size,
        contract_size=args.contract_size,
        spread_pips=args.spread,
        risk_per_trade=args.risk,
    )

    print(f"[回测] 运行中...\n")
    result = engine.run(candles, strategy, symbol=args.symbol, timeframe=args.timeframe)

    # ── 4. 输出结果 ──
    print(result.summary_text())

    if args.trades and result.trades:
        print(f"\n{'─' * 80}")
        print(f"  逐笔交易明细 ({len(result.trades)} 笔)")
        print(f"{'─' * 80}")
        print(f"  {'#':>3}  {'方向':<4}  {'入场价':>10}  {'出场价':>10}  "
              f"{'盈亏点数':>8}  {'盈亏金额':>10}  {'出场原因':<14}")
        print(f"  {'─' * 74}")
        for t in result.trades:
            print(
                f"  {t.id:>3}  {t.direction:<4}  {t.entry_price:>10.5f}  "
                f"{t.exit_price:>10.5f}  {t.profit_pips:>8.1f}  "
                f"{t.profit_loss:>10.2f}  {t.exit_reason:<14}"
            )

    if args.output:
        Path(args.output).write_text(result.to_json(), encoding="utf-8")
        print(f"\n[输出] JSON 结果已保存至 {args.output}")


if __name__ == "__main__":
    main()
