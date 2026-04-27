# QuantMatrix-MT5

自动化量化交易平台，直接对接 MetaTrader 5。Node.js + Express 后端通过 Python bridge 调用 MT5 终端，提供 live trading、paper trading、backtest、optimizer、风控、仓位监控、Telegram 推送和 Web dashboard。

> ⚠️ **风险提示（请先看完再继续）**
>
> - 自动化交易**不保证盈利**，可能造成资金完全亏损。
> - 回测结果**不等于**实盘结果（spread、slippage、commission、swap、broker fill 都会拉低真实表现）。
> - 上实盘之前**必须**先用 demo 账户 + paper trading 跑足够长时间，验证逻辑、风控、Telegram 报警、断线重连都正常。
> - 默认 `ALLOW_LIVE_TRADING=false`、`TRADING_ENABLED=false`，请保持这种保守默认值。

---

## 目录

1. [项目简介](#1-项目简介)
2. [核心功能](#2-核心功能)
3. [项目结构](#3-项目结构)
4. [快速启动（Windows 本地）](#4-快速启动windows-本地)
5. [VPS 部署](#5-vps-部署)
6. [.env 配置说明](#6-env-配置说明)
7. [API 简介](#7-api-简介)
8. [回测说明](#8-回测说明)
9. [风控说明](#9-风控说明)
10. [常见 MT5 错误](#10-常见-mt5-错误)
11. [开发注意事项](#11-开发注意事项)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. 项目简介

QuantMatrix-MT5 是一个跑在 Windows / Windows VPS 上的自动化交易系统，组成：

- **Node.js + Express 后端**（`src/server.js`）：策略调度、风控、仓位监控、回测、API、WebSocket。
- **Python MT5 bridge**（`mt5_bridge.py`）：通过官方 `MetaTrader5` Python 包直接连终端，与 Node 之间走 stdin/stdout JSON 行协议。
- **MetaTrader 5 终端**：必须运行在同一台 Windows 机器上并已登录 broker。
- **嵌入式 NeDB 数据库**：交易、仓位、回测结果、策略实例、用户、审计日志全部落到本地 `data/`，不需要外部数据库。
- **Web dashboard**：`public/index.html` 单页应用，通过 REST + WebSocket 实时显示行情、持仓、信号、风控状态。

特点：

- 支持 live trading、paper trading、backtest、batch backtest、parameter optimizer。
- 多策略、多品种、多 timeframe，按 RiskProfile / strategyInstance 分层配置。
- 仓位管理（保本、移动止损、部分止盈、新闻保护、early adverse 监控）默认全部保守，自动动作必须显式开启。
- Telegram 实时通知关键事件（开单 / 平仓 / 风控触发 / 部分止盈等）。

再次强调：**回测好看 ≠ 能赚钱。先 demo + paper trading 至少跑一段，再考虑小额实盘。**

---

## 2. 核心功能

| 功能 | 说明 |
|------|------|
| **MT5 direct connection** | 通过官方 `MetaTrader5` Python 包直接连终端，不依赖 EA 或文件桥。 |
| **Python bridge** | `mt5_bridge.py` 由 Node 子进程拉起，stdin/stdout JSON 行协议，自动检测 broker 支持的 filling mode（FOK / IOC / RETURN）。 |
| **Live trading** | `TRADING_ENABLED=true` 且 `ALLOW_LIVE_TRADING=true` 时，strategyEngine 按 cadence 推送信号到 tradeExecutor 下真实单。 |
| **Paper trading** | `PAPER_TRADING_ENABLED=true` 时并行模拟撮合，不下真实单，便于线上验证策略行为。 |
| **Strategy engine** | `src/services/strategyEngine.js` 负责按 timeframe 调度策略，给出 BUY / SELL / HOLD 信号，支持 multi-timeframe 和 lower-timeframe entry。 |
| **多策略** | `TrendFollowing`、`MeanReversion`、`MultiTimeframe`、`Momentum`、`Breakout`、`VolumeFlowHybrid`，全部继承 `BaseStrategy`，可加新策略而不改 engine。 |
| **Risk manager** | 单笔风险、日内亏损、最大回撤、并发持仓数、单品种持仓数、同方向限制、相同入场冷却窗口、亏损后冷却。 |
| **Strategy daily stop** | 某 strategy + symbol + timeframe 当天连亏达到阈值后，当日禁止再开新仓（不影响已有仓位管理）。 |
| **Position monitor** | 双 cadence（light + heavy）扫描持仓；外部平仓自动同步、deal reconciliation；新闻 blackout 时切到 fast mode。 |
| **Trade management** | 保本（breakeven）、移动止损（trailing）、部分止盈（partial TP）、early adverse 监控、setup invalidation、新闻保护，所有自动动作默认 OFF。 |
| **Backtest engine** | 单策略回测，支持 cost model（commission、swap、fixed fee、commissionPerSide、spread、slippage），按 R-multiple 输出统计。 |
| **Batch backtest** | 一次跑多 symbol × strategy × timeframe，输出对比表 + 持久化。 |
| **Optimizer** | 参数网格搜索（`src/services/optimizerService.js`）+ worker 进程（`src/workers/optimizerWorker.js`），输出每个参数组合的指标。 |
| **Telegram notification** | 开单 / 平仓 / 风控阻断 / 仓位管理重要事件 / 远程 URL 变更 / 每日报告。 |
| **WebSocket dashboard** | 单页应用 `public/index.html`，订阅 `positions`、`trades`、`signals`、`monitor` 等 channel 实时刷新。 |
| **Diagnostics** | `/api/diagnostics`：MT5 连接、symbol info、tick stale 检测、交易许可、broker stops level、margin 等自检。 |
| **Maintenance** | `/api/maintenance`：缓存清理、经济日历刷新、数据库 compact 等运维工具。 |

---

## 3. 项目结构

```
QuantMatrix-MT5/
├── src/
│   ├── server.js                # Express 入口 + 启动顺序
│   ├── routes/                  # 路由
│   │   ├── authRoutes.js
│   │   ├── userRoutes.js
│   │   ├── tradingRoutes.js
│   │   ├── positionRoutes.js
│   │   ├── tradeRoutes.js
│   │   ├── strategyRoutes.js
│   │   ├── strategyInstanceRoutes.js
│   │   ├── backtestRoutes.js
│   │   ├── optimizerRoutes.js
│   │   ├── notificationRoutes.js
│   │   ├── paperTradingRoutes.js
│   │   ├── riskSettingsRoutes.js
│   │   ├── diagnosticsRoutes.js
│   │   └── maintenanceRoutes.js
│   ├── controllers/             # 请求处理
│   ├── services/                # 业务核心
│   │   ├── mt5Service.js                   # 与 Python bridge 通讯
│   │   ├── strategyEngine.js               # 策略调度 / 信号生成
│   │   ├── tradeExecutor.js                # 下单 / 改单 / 平仓
│   │   ├── riskManager.js                  # 风控
│   │   ├── strategyDailyStopService.js     # 日内单策略停止
│   │   ├── positionMonitor.js              # 持仓双 cadence 扫描
│   │   ├── trailingStopService.js          # 移动止损
│   │   ├── breakevenService.js             # 保本逻辑
│   │   ├── tradeManagementService.js       # 仓位管理（默认全部保守）
│   │   ├── tradeManagementConfig.js        # 仓位管理 policy 解析
│   │   ├── backtestEngine.js               # 单策略回测
│   │   ├── batchBacktestService.js         # 批量回测
│   │   ├── optimizerService.js             # 参数优化
│   │   ├── notificationService.js          # Telegram + 邮件
│   │   ├── websocketService.js             # WebSocket 广播
│   │   ├── economicCalendarService.js      # 经济日历 + 新闻 blackout
│   │   ├── auditService.js                 # 审计日志
│   │   ├── paperTradingService.js          # 模拟撮合
│   │   ├── remoteAccessService.js          # ngrok 远程访问
│   │   └── ...                             # （还有其它支持服务）
│   ├── strategies/              # 策略实现
│   │   ├── BaseStrategy.js
│   │   ├── TrendFollowingStrategy.js
│   │   ├── MeanReversionStrategy.js
│   │   ├── MultiTimeframeStrategy.js
│   │   ├── MomentumStrategy.js
│   │   ├── BreakoutStrategy.js
│   │   └── VolumeFlowHybridStrategy.js
│   ├── models/                  # NeDB 数据模型
│   │   ├── User.js
│   │   ├── Position.js
│   │   ├── Trade.js
│   │   ├── Strategy.js
│   │   ├── StrategyInstance.js
│   │   ├── RiskProfile.js
│   │   ├── Backtest.js
│   │   ├── BatchBacktestJob.js
│   │   ├── OptimizerRun.js
│   │   ├── DecisionAudit.js
│   │   ├── ExecutionAudit.js
│   │   └── TradeLog.js
│   ├── config/                  # 静态配置
│   │   ├── db.js                # NeDB datastore 初始化
│   │   ├── jwt.js               # JWT helpers
│   │   ├── instruments.js       # 品种 / pipSize / lotStep / spread 默认值
│   │   ├── strategyParameters.js
│   │   ├── strategyExecution.js
│   │   ├── newsBlackout.js
│   │   └── defaultAssignments.js
│   ├── utils/                   # 纯工具
│   │   ├── backtestCostModel.js
│   │   ├── batchBacktestAnalysis.js
│   │   ├── instrumentValuation.js
│   │   ├── mt5Reconciliation.js
│   │   ├── positionExitState.js
│   │   ├── candleRange.js
│   │   ├── timeframe.js
│   │   └── ...
│   ├── middleware/              # auth / validate
│   └── workers/                 # 子进程（如 optimizerWorker.js）
├── mt5_bridge.py                # Python ↔ MT5 终端的 JSON 桥
├── requirements.txt             # Python 依赖（MetaTrader5）
├── public/                      # dashboard 前端
│   ├── index.html
│   └── vendor/
├── data/                        # NeDB 数据文件（自动创建）
├── logs/                        # 日志（自动创建，含 system.log / error.log）
├── tests/                       # Jest 单测
├── tmp/                         # 临时脚本（smoke test 等）
├── scripts/                     # 辅助脚本（如 start-remote-access.js）
├── start.bat                    # Windows 一键启动
├── start-remote.bat             # 启动 + ngrok 公网隧道
├── package.json
├── package-lock.json
└── jest.config.js
```

---

## 4. 快速启动（Windows 本地）

下面流程假设你在自己的 Windows 机器（Win 10/11）上运行。

### 4.1 准备 MT5

1. 下载并安装 MetaTrader 5（官方或 broker 提供的版本）。
2. 用 broker 的账户（**先用 demo**）登录 MT5 终端。
3. 在终端里 **Tools → Options → Expert Advisors** 打开 *Allow algorithmic trading*。
4. 保持 MT5 终端在自动交易期间一直运行。

### 4.2 准备 Python

`mt5_bridge.py` 用官方 `MetaTrader5` Python 包，必须装在能被 Node 找到的 Python 里。

```powershell
:: 安装 Python 3.10+（官网或 winget）
winget install Python.Python.3.11

:: 安装 MetaTrader5 包
pip install MetaTrader5
:: 或者：
pip install -r requirements.txt
```

如果有多个 Python，把 `.env` 里的 `PYTHON_PATH` 显式指到正确的 `python.exe`。

### 4.3 配置 .env

第一次运行 `start.bat` 会自动从 `.env.example` 拷一份。也可以手动：

```powershell
copy .env.example .env
notepad .env
```

至少检查：`MT5_LOGIN`、`MT5_PASSWORD`、`MT5_SERVER`、`TELEGRAM_TOKEN`、`TELEGRAM_CHAT_ID`、`MAX_RISK_PER_TRADE`、`TRADING_ENABLED`、`ALLOW_LIVE_TRADING`、`PAPER_TRADING_ENABLED`。详见 [§6 .env 配置说明](#6-env-配置说明)。

### 4.4 启动

最简单的方式：

```powershell
:: 双击 start.bat，或：
.\start.bat
```

`start.bat` 会：

- 检查/下载 portable Node.js（如果系统没装），
- `npm ci` 安装依赖，
- 自动找 MT5 并启动它（如果还没开），
- 启动 `node src/server.js`，
- 自动打开浏览器。

如果你已经有 Node.js（≥ 18 推荐）：

```powershell
npm install        :: 第一次
npm start          :: 生产模式
:: 或开发模式：
npm run dev        :: nodemon 自动重启
```

### 4.5 启动后检查

1. 浏览器打开 <http://localhost:5000>，看到 dashboard。
2. 调健康检查：

   ```powershell
   curl http://localhost:5000/api/health
   ```

   返回 `{"success": true, ...}` 即代表服务起来了。
3. 在 dashboard 里检查 MT5 连接状态、账户余额、symbol 报价。
4. **先跑 paper trading 或 backtest，不要直接 live。**
   - paper：把 `PAPER_TRADING_ENABLED=true` 重启服务。
   - backtest：dashboard 里发 backtest 任务，或用 `POST /api/backtest`（见 §8）。

---

## 5. VPS 部署

QuantMatrix 必须跑在 **Windows VPS** 上，因为 `MetaTrader5` Python 包只支持 Windows 终端。

### 5.1 部署步骤

1. **选 VPS**：Windows Server 2019/2022 或 Win 10/11，2 vCPU / 4 GB RAM 起步，机房尽量靠近 broker 服务器。
2. **上传项目**：通过 RDP 拖拽、SFTP、或 `git clone`。
3. **装 MT5**：在 VPS 上装好 broker 提供的 MT5 客户端，登录账户，打开 algorithmic trading。
4. **装 Python + 依赖**：

   ```powershell
   winget install Python.Python.3.11
   pip install -r requirements.txt
   ```

5. **配 `.env`**：参考 [§6](#6-env-配置说明)，至少把 `MT5_*` 和 `TELEGRAM_*` 填好。
6. **首跑**：双击 `start.bat`，确认 dashboard 能打开、`/api/health` 正常、MT5 已连接。

### 5.2 远程访问（ngrok）

如果想从手机或外部网络访问 dashboard：

1. 注册 ngrok，把 `NGROK_AUTHTOKEN` 填进 `.env`。
2. 运行 `start-remote.bat`（不是 `start.bat`），它会：
   - 启 QuantMatrix 服务，
   - 起 ngrok HTTPS 隧道，
   - 公网入口加一层 Basic Auth（保护登录页之前），
   - URL 变化时通过 Telegram 把新地址发给你。
3. `ALLOW_SELF_REGISTRATION=false` 时，公网入口注册被禁，只能用已有用户登录。

### 5.3 保持后台运行

VPS 上需要让进程长期跑：

| 方法 | 说明 |
|------|------|
| **PowerShell 隐藏窗口** | `powershell -Command "Start-Process -WindowStyle Hidden cmd '/c start.bat'"`，最简单。 |
| **PM2**（需要 Node 版 PM2） | `npm install -g pm2 && pm2 start src/server.js --name qmtx`，能崩溃自动重启 + 日志切割。 |
| **Task Scheduler** | 设置「登录时启动」+「失败时重启」，重启 VPS 后会自动拉起。 |
| **NSSM** | 把 Node 注册成 Windows Service，最稳定但配置稍麻烦。 |

### 5.4 注意

- VPS 不能让它**休眠 / 自动重启**，否则 MT5 会断；如果开了自动 Windows Update 重启，要做监控（Telegram 心跳 / `/api/health` ping）。
- MT5 终端必须一直开着，重启 VPS 后要确认 MT5 自动登录。
- 对于自动重启，建议用 PM2 / NSSM 让 Node 服务跟着系统启动；同时让 MT5 加到 startup folder。

---

## 6. .env 配置说明

完整字段见 `.env.example`。下面按用途分组解释。

### 6.1 Server

```ini
NODE_ENV=development
PORT=5000                       # HTTP + WebSocket 端口
FRONTEND_URL=http://localhost:5000
PUBLIC_BASE_URL=                # 留空时由 ngrok 自动填
TRUST_PROXY=1                   # 在 ngrok / Cloudflare 后面要设 1
```

### 6.2 JWT

```ini
JWT_SECRET=...                  # 不填会自动随机生成（重启后失效，建议显式设）
JWT_EXPIRE=24h
JWT_REFRESH_SECRET=...
JWT_REFRESH_EXPIRE=7d
```

### 6.3 SMTP（密码重置邮件，可选）

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
FROM_EMAIL=noreply@quantmatrix.com
FROM_NAME=QuantMatrix
```

### 6.4 Remote access（ngrok）

```ini
ALLOW_SELF_REGISTRATION=false   # 公网入口安全开关
REMOTE_URL_NOTIFY=true          # ngrok URL 变更时 Telegram 通知
NGROK_AUTHTOKEN=
# NGROK_BASIC_AUTH_USER=...
# NGROK_BASIC_AUTH_PASSWORD=...
# NGROK_API_URL=http://127.0.0.1:4040/api/tunnels
```

### 6.5 MT5

```ini
MT5_LOGIN=230044684             # broker 账号
MT5_PASSWORD=...                # 交易/只读密码
MT5_SERVER=Elev8-Demo2          # broker server 名
# MT5_PATH=C:\Program Files\MetaTrader 5\terminal64.exe   # 自动检测，必要时显式指定
# PYTHON_PATH=python                                       # 多 Python 时显式指定
```

> `MT5_PATH` 找不到 → bridge 起不来；`PYTHON_PATH` 错 → `Python was not found`。详见 §12 Troubleshooting。

### 6.6 Telegram

```ini
TELEGRAM_TOKEN=                 # 通过 @BotFather 创建 bot 拿到
TELEGRAM_CHAT_ID=               # 给 bot 发消息后访问 https://api.telegram.org/bot<TOKEN>/getUpdates 找
```

不填 Telegram 也能跑，但收不到关键事件通知。

### 6.7 Trading configuration（核心风控）

```ini
MAX_RISK_PER_TRADE=0.05         # 单笔风险占 equity 比例上限（0.05 = 5%）
MAX_DAILY_LOSS=0.25             # 当日累计亏损上限（0.25 = 25%），触及则停 live
MAX_DRAWDOWN=0.5                # 总回撤上限
MAX_CONCURRENT_POSITIONS=5      # 同时持仓最多 5 个
MAX_POSITIONS_PER_SYMBOL=2      # 同 symbol 最多 2 个
TRADING_ENABLED=false           # live trading loop 总开关
ALLOW_LIVE_TRADING=false        # 真实账户的最终保险（双闸）
```

**两个开关的关系**：

- `ALLOW_LIVE_TRADING=false`：哪怕 `TRADING_ENABLED=true`，真实账户**也不会**下单（强制 demo / paper）。这是部署到陌生机器、调试时的最终保险。
- `TRADING_ENABLED`：控制 live trading 主 loop 是否运行（信号 → 下单链路）。
- 上实盘必须**两个都开**：`TRADING_ENABLED=true` + `ALLOW_LIVE_TRADING=true`。**默认两个都关，请保持这个保守默认值。**

### 6.8 Paper trading

```ini
PAPER_TRADING_ENABLED=false     # paper trading 模拟撮合开关
DAILY_REPORT_HOUR=23            # 每日 Telegram 报告时间（24h）
DAILY_REPORT_MINUTE=55
```

paper 与 live 互不影响，可以并行：用 paper 做线上 A/B 验证，用 live 跑已经验证过的策略。

---

## 7. API 简介

所有路由前缀在 `src/server.js` 里挂载。下面只列分类和大致用途，详细字段直接看对应 controller。

| 前缀 | 用途 |
|------|------|
| `/api/auth` | 注册 / 登录 / 登出 / 刷新 token / 密码重置（带速率限制）。 |
| `/api/users` | 当前用户信息、修改资料、改密码（需登录）。 |
| `/api/trading` | 启停 live trading loop、当前账户状态、live assignments。 |
| `/api/positions` | 查持仓、手动平仓 / 部分平仓 / 改 SL/TP。 |
| `/api/trades` | 历史成交、对账、导出 CSV。 |
| `/api/strategies` | 策略元信息、默认参数、启用 / 禁用。 |
| `/api/strategy-instances` | symbol × strategy × timeframe 实例配置（每个实例独立参数 + tradeManagement override）。 |
| `/api/backtest` | 单策略回测 / 跑全部策略 / 历史结果查询，详见 §8。 |
| `/api/optimizer` | 参数网格优化任务的提交 / 进度 / 结果。 |
| `/api/notifications` | Telegram 测试、推送配置、查看历史通知。 |
| `/api/paper-trading` | paper 仓位 / 历史 / 启停。 |
| `/api/risk-settings` | 风控参数（RiskProfile）增删查改、激活某 profile。 |
| `/api/diagnostics` | MT5 连通性、symbol 自检、tick 时效、broker stops level、margin 等运行期诊断。 |
| `/api/maintenance` | 缓存清理、经济日历刷新、数据库 compact 等运维端点。 |
| `/api/ws/status` | WebSocket 客户端数 / 连接信息（需登录）。 |
| `/api/health` | 不需要鉴权的存活探针，VPS 监控用这个。 |
| `WebSocket /ws` | 实时推送 `positions`、`trades`、`signals`、`monitor`、`position_management_event` 等。 |

---

## 8. 回测说明

### 8.1 跑单策略

```http
POST /api/backtest
Content-Type: application/json

{
  "symbol": "XAUUSD",
  "strategyType": "MultiTimeframe",
  "timeframe": "1h",
  "startDate": "2025-01-01",
  "endDate": "2025-12-31",
  "initialBalance": 10000
}
```

返回里包含：

- `summary`：trades 数、winRate、profitFactor、netProfitMoney、grossProfitMoney、grossLossMoney、maxDrawdownPct、totalCommission、totalSwap、totalFees、totalTradingCosts、grossNetDifference 等。
- `trades`：每笔交易的入场 / 出场 / R-multiple / commission / swap / fee / 最终 P&L。
- `equityCurve`：账户权益曲线。

### 8.2 跑全部策略

```http
POST /api/backtest/all
{
  "symbol": "EURUSD",
  "timeframe": "15m",
  "startDate": "2025-01-01",
  "endDate": "2025-06-30",
  "initialBalance": 5000
}
```

会针对该 symbol/timeframe 跑所有可用策略，返回对比表，便于挑当前市场状态下表现最好的策略。

### 8.3 Batch backtest

`/api/backtest/batch` 跑 `symbol[] × strategy[] × timeframe[]` 矩阵，结果落到 `BatchBacktestJob`，dashboard 可视化。

### 8.4 Cost model（重要）

回测如果不算成本，profit factor 会虚高。请显式带 `costModel`：

```http
POST /api/backtest
{
  "symbol": "EURUSD",
  "strategyType": "TrendFollowing",
  "timeframe": "15m",
  "startDate": "2025-01-01",
  "endDate": "2025-06-30",
  "initialBalance": 500,
  "spreadPips": 1.2,
  "slippagePips": 0.5,
  "costModel": {
    "commissionPerLot": 7,
    "commissionPerSide": true,
    "swapLongPerLotPerDay": -1.5,
    "swapShortPerLotPerDay": -2.5,
    "fixedFeePerTrade": -0.10
  }
}
```

字段含义：

- `commissionPerLot`：每手佣金，正数会被处理成负 P&L。
- `commissionPerSide=true`：开仓 + 平仓各扣一次（ECN broker 通常是这样）。
- `swapLongPerLotPerDay` / `swapShortPerLotPerDay`：过夜利息，按 UTC 跨天数 × 手数计算。
- `fixedFeePerTrade`：每笔固定费（场内费、规费等）。

层级：`request.costModel` > strategy override > instrument 默认 > 全零。详见 `src/utils/backtestCostModel.js` 和 `tests/backtest-cost-model.test.js`。

### 8.5 怎么看指标

| 指标 | 怎么看 |
|------|--------|
| **Win rate** | 胜率不是越高越好，要结合 R/R。 |
| **Profit factor** | 总盈利 / 总亏损，> 1.5 算稳，> 2 比较好；< 1 不要碰。 |
| **Max drawdown** | 历史最大回撤，决定能不能扛过差期。 |
| **Net profit / Gross profit** | net = gross 收益 − gross 亏损 − 所有 cost。差距大 = cost 在吃利润。 |
| **Commission / Swap / Fee** | 单独列出来才能看清成本结构；隔夜过多就要重算 swap。 |
| **grossNetDifference** | gross 与 net 的差额，应等于 `totalTradingCosts` 的绝对值（smoke test 验过）。 |

### 8.6 回测和实盘的差距

回测 ≠ 实盘，至少注意：

- **Spread**：实盘是浮动的，回测往往用固定值（用 broker 在你交易时间段的平均 spread 校准）。
- **Slippage**：尤其新闻、低流动性时。
- **Commission / Swap**：必须按 broker 真实费率配 cost model。
- **Fill quality**：回测假设按收盘价成交，实盘可能成交价更差。
- **Server 时区 vs broker 时区**：影响过夜计算。
- **Symbol 合约规格**：contract size、margin、stops level；多账户 broker 不一样。

**回测漂亮 → 先 demo + paper trading 跑一段 → 再考虑小额实盘。**

---

## 9. 风控说明

风控分两层：**全局 RiskProfile**（`src/models/RiskProfile.js`，可以多个，但只有一个 active）和 **strategy instance override**（每个 symbol × strategy × timeframe 可以再覆盖）。

### 9.1 全局风控参数（RiskProfile / .env）

| 参数 | 含义 |
|------|------|
| `maxRiskPerTrade` | 单笔风险占 equity 比例（如 0.02 = 2%）。配合 SL 距离反推 lot。 |
| `maxDailyLoss` | 当日累计亏损达此比例后阻断 live trading（不影响仓位管理）。 |
| `maxDrawdown` | 总账户回撤上限。 |
| `maxConcurrentPositions` | 同时最多多少持仓。 |
| `maxPositionsPerSymbol` | 同 symbol 最多多少持仓（避免叠仓）。 |
| `categoryExposureLimit` | 按品种类别（FX / metals / indices / crypto）限制总敞口。 |
| `sameDirectionLimit` | 同方向最多几个仓位（避免追单）。 |
| `duplicateEntryWindow` | 同 strategy + symbol 在 N 分钟内不能再次开同向仓。 |
| `cooldownAfterLoss` | 触发亏损后等待多少分钟才允许再开仓。 |

### 9.2 Strategy daily stop（重要）

`src/services/strategyDailyStopService.js`：某个 **strategy + symbol + timeframe** 当天连续亏损达到阈值（默认 N 笔）后，**当日暂停该实例的新开仓**，直到 UTC 0 点重置。

注意：

- 只阻止**新开仓**，不影响该实例已有持仓的 SL / TP / trailing / partial。
- 不影响其它 strategy / symbol / timeframe。
- dashboard 和 audit log 会记录原因，便于复盘。

### 9.3 Position management（开单后管理）

`src/services/tradeManagementService.js` 在 `positionMonitor` 之后跑，提供保守的开单后管理：

- **Early protection**：开单后前 N 分钟（默认 5）走快扫描，如果 R 多在 -0.5R 以下记 audit；只有 `enableEarlyAdverseExit=true` 才自动平。
- **Breakeven**：unrealizedR ≥ 0.8R 提示，≥ 1.0R 移到 BE（必须 `allowMoveToBreakeven=true`）。
- **Partial TP**：unrealizedR ≥ 1.5R 提示，按 `partialCloseRatio` 部分平（必须 `allowPartialTakeProfit=true`，且 broker minLot / lotStep 合法）。
- **Setup invalidation**（仅 heavy scan）：≥ 2 个独立信号确认（趋势翻转、对向信号、关键 EMA 跨越）才报 invalidation；只有 `enableExitOnInvalidation=true` 才自动平。
- **News protective**：新闻 blackout 期间记审计；只有 `enableNewsProtectiveBreakeven=true` 才在浮盈时把 SL 推到 BE。

**所有自动动作默认 OFF**，未配置时只写 `managementEvents` 审计记录、广播 WebSocket、必要时 Telegram 通知。要启用自动动作，在 RiskProfile 或 strategyInstance 的 `tradeManagement.policy` 里显式打开。

### 9.4 Trailing / breakeven

- `breakevenService`：触发后把 SL 推到入场价（可加 spread compensation + 缓冲）。
- `trailingStopService`：按 ATR 倍数动态跟踪 SL；支持 partial close + step trailing。
- 这两个跟 `tradeManagementService` 是叠加关系，不冲突。

---

## 10. 常见 MT5 错误

下面是 bridge 和 broker 常返回的错误，遇到先看这个。

| 错误 | 含义 | 排查 |
|------|------|------|
| **10009 DONE** | 操作成功（不是错误）。 | 不用处理。 |
| **10016 INVALID_STOPS** | SL/TP 不合法。 | broker 有最小止损距离（stops level，pips 数），SL 离当前价太近 / 方向反了 / TP 在 SL 同侧都会触发。检查 `symbol_info_tick` + `stops_level`。 |
| **10034 LIMIT_VOLUME** | 单品种持仓总量 / 单笔 lot 超 broker 限制。 | 看 `symbol_info.volume_max` 和你的 `MAX_POSITIONS_PER_SYMBOL`，必要时分批下。 |
| **MARKET_CLOSED** | 市场已关闭。 | 周末、节假日、broker 维护、symbol 不在交易时段；FX 是周一亚盘开 → 周五晚收。 |
| **INVALID_VOLUME** | lot 不合法。 | lot < `volume_min` 或不是 `volume_step` 的倍数。下单前要 snap 到 lotStep。 |
| **PRICE_CHANGED** | 报价变了。 | 通常 retry 一次就好；新闻时 retry 也容易再失败。检查 deviation 参数。 |
| **CONNECTION** | 连接问题。 | MT5 终端被关 / 网断 / broker server 重启；bridge 要能自动重连。 |
| **TRADE_DISABLED** | 账户或品种禁交易。 | broker 端关了交易许可、demo 过期、实盘账户没开 algorithmic trading；用 `/api/diagnostics` 查 `trade_allowed`。 |
| **NO_MONEY** | 保证金不足。 | margin requirement 超过 free margin；降 lot、平掉部分持仓、或补保证金。 |

调用 `/api/diagnostics` 能一键自检 connection / symbol / margin / trade_allowed / stops_level。

---

## 11. 开发注意事项

写给后续 Codex / Claude / 任何接手的开发者（包括我自己）：

- **不要重命名核心文件**：`src/server.js`、`mt5_bridge.py`、`positionMonitor.js`、`trailingStopService.js`、`breakevenService.js`、`riskManager.js`、`strategyEngine.js` 是其它模块的硬依赖，重命名前先全局 grep。
- **不要删除已有策略**：`src/strategies/` 下的 6 个策略都被 `strategyEngine.getStrategiesInfo()` 注册，删一个会让 `Strategy.initDefaults` 启动失败 + dashboard 报错。
- **不要破坏 dashboard SPA fallback**：`server.js` 的 `app.get('*')` 兜底返回 `public/index.html`，前端路由依赖它。
- **新功能默认关闭**：任何能影响真实账户行为的开关（自动平仓、自动加仓、自动改 SL/TP）默认必须 `false`，要显式 opt-in。看 `tradeManagementConfig.js` 的写法。
- **live trading 改动要保守**：改 `tradeExecutor` / `riskManager` / `strategyDailyStopService` 之前先想 worst case；先 paper / backtest 验证。
- **backtest 与 live sizing 一致**：lot 计算、commission、swap、stops level 不能两边规则不同，否则回测白做。共享 `src/utils/instrumentValuation.js` 和 `src/utils/backtestCostModel.js`。
- **positionMonitor 必须容错**：单次扫描里某个仓位计算出错，绝不能让整个 monitor loop 挂掉。所有 per-position 逻辑包 try/catch，保证下一个仓位还能扫。
- **所有交易动作要写 audit log**：开单 / 改单 / 部分平 / 全平 / 风控阻断 → `auditService.{orderPlaced,orderClosed,positionManaged,riskBlocked}`，不写 audit 出问题没法复盘。
- **所有自动操作必须可配置**：partial close ratio、trailing distance、breakeven trigger、early adverse R 阈值都从 policy 拿，不要硬编码到代码里。
- **路由变化要小心**：dashboard 直接 `fetch('/api/...')`，改 URL 前要看前端有没有用，必要时加 alias。
- **跑测试再提**：`npm test` 跑完整 Jest 套，重点关注 backtest / breakeven / position monitor / cost model 这几块。

---

## 12. Troubleshooting

按出现频率从高到低排：

### `Python was not found`

- 系统没装 Python，或 `python` 没在 PATH。
- 装一个 Python 3.10+，或在 `.env` 里设 `PYTHON_PATH=C:\Python311\python.exe`。

### `MetaTrader5 package not installed`

```powershell
pip install MetaTrader5
```

如果有多个 Python，用对应那个的 pip：`C:\Python311\python.exe -m pip install MetaTrader5`。

### `MT5_LOGIN not configured`

- `.env` 没填或字段拼错。检查 `MT5_LOGIN` / `MT5_PASSWORD` / `MT5_SERVER` 三个都在。
- 注意 server 名要和 broker 终端登录界面里显示的一字不差（区分大小写）。

### MT5 bridge startup timeout

- MT5 终端没启动 / 没登录 → 启动 + 登录后重试。
- MT5 终端禁了 algorithmic trading → 终端 Tools → Options → Expert Advisors 打开。
- `MT5_PATH` 指错 → 让 `start.bat` 自动检测，或显式设到 `terminal64.exe`。
- broker 实盘账户被风控暂停 → 用 demo 验证。

### `Port 5000 already in use`

```powershell
:: 看谁占用：
Get-NetTCPConnection -LocalPort 5000 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }
:: 要么关了那个进程，要么改 .env 里的 PORT
```

### Dashboard 打不开

- 浏览器开 <http://localhost:5000/api/health>，能返回 JSON 说明后端好的。
- 如果是 ngrok 公网地址：
  - 检查 `NGROK_AUTHTOKEN` 是否填了。
  - 检查是否被 Basic Auth 拦在前面（用户名 / 密码看 `.env`）。
  - 看 `start-remote.bat` 控制台是否报隧道建立失败。
- 静态资源 404 → `public/index.html` 不存在或被删了（不要删）。

### Telegram 没收到通知

- `TELEGRAM_TOKEN` / `TELEGRAM_CHAT_ID` 任意一个错了都不会报错，bot 会静默吞。
- 测试：`POST /api/notifications/test`（dashboard 里也有按钮）。
- 检查 chat_id 是不是负数（频道是负的，私聊是正的）。
- bot 没被 chat 里 `/start` 过 → 给 bot 发一条消息再获取 chat_id。

### ngrok URL 无法访问

- 免费 ngrok 每次启动 URL 会变；开了 `REMOTE_URL_NOTIFY=true` 会 Telegram 推新地址。
- 公网入口需要先过 Basic Auth（用户 / 密码看 `.env` 的 `NGROK_BASIC_AUTH_*`）。
- 自家 ISP / Cloudflare 拦了 ngrok 域名 → 切到付费 reserved domain 或自建 reverse tunnel。

### Market closed

- 周末、节假日或 broker 维护时段。
- FX 大约 周一 00:00 GMT 开 → 周五 22:00 GMT 收，metals / indices 不一样。
- 用 `/api/diagnostics` 查具体 symbol 的交易时段。

### Invalid stops

- SL 离当前价太近 → 比 broker 的 stops level 还小（一般 broker 给 5–20 pips）。
- 方向错了：BUY 仓 SL 应在入场价之下，TP 在之上；SELL 反之。
- 报价小数位不匹配：5 位 broker 和 4 位 broker 的 pip 表示不同，确保走 `instrument.pipSize`。

### Volume limit reached

- 单笔 lot 超 `symbol_info.volume_max` → 拆单。
- 同 symbol 仓位数量到了 `MAX_POSITIONS_PER_SYMBOL` → 等其它仓位关闭或调高上限（小心！）。
- broker 账户级别 volume 限制 → 联系 broker 升级。

---

## License

ISC
