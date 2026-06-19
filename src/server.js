const bootProfiler = require('./utils/bootProfiler');
bootProfiler.mark('boot:start');

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

const connectDB = bootProfiler.measure('db:module-load', () => require('./config/db'));
const { protect } = require('./middleware/auth');
bootProfiler.measure('mt5:init', () => require('./services/mt5Service'));

const {
  authRoutes,
  userRoutes,
  tradingRoutes,
  positionRoutes,
  tradeRoutes,
  strategyRoutes,
  strategyInstanceRoutes,
  symbolPlaybookRoutes,
  symbolCustomRoutes,
  backtestRoutes,
  optimizerRoutes,
  notificationRoutes,
  paperTradingRoutes,
  riskSettingsRoutes,
  diagnosticsRoutes,
  maintenanceRoutes,
  dataSyncRoutes,
  systemRoutes
} = bootProfiler.measure('routes:load', () => ({
  authRoutes: require('./routes/authRoutes'),
  userRoutes: require('./routes/userRoutes'),
  tradingRoutes: require('./routes/tradingRoutes'),
  positionRoutes: require('./routes/positionRoutes'),
  tradeRoutes: require('./routes/tradeRoutes'),
  strategyRoutes: require('./routes/strategyRoutes'),
  strategyInstanceRoutes: require('./routes/strategyInstanceRoutes'),
  symbolPlaybookRoutes: require('./routes/symbolPlaybookRoutes'),
  symbolCustomRoutes: require('./routes/symbolCustomRoutes'),
  backtestRoutes: require('./routes/backtestRoutes'),
  optimizerRoutes: require('./routes/optimizerRoutes'),
  notificationRoutes: require('./routes/notificationRoutes'),
  paperTradingRoutes: require('./routes/paperTradingRoutes'),
  riskSettingsRoutes: require('./routes/riskSettingsRoutes'),
  diagnosticsRoutes: require('./routes/diagnosticsRoutes'),
  maintenanceRoutes: require('./routes/maintenanceRoutes'),
  dataSyncRoutes: require('./routes/dataSyncRoutes'),
  systemRoutes: require('./routes/systemRoutes')
}));

const {
  Strategy,
  StrategyInstance,
  websocketService,
  notificationService,
  notificationHubService,
  fileLogger,
  remoteAccessService,
  strategyEngine,
  economicCalendarService,
  resourceMonitorService,
  dataSyncSchedulerService,
  runtimeHeartbeatService,
  symbolCustomPaperRuntimeService,
  symbolCustomLiveRuntimeService,
  symbolCustomPaperCandleProviderService
} = bootProfiler.measure('runtime:load', () => ({
  Strategy: require('./models/Strategy'),
  StrategyInstance: require('./models/StrategyInstance'),
  websocketService: require('./services/websocketService'),
  notificationService: require('./services/notificationService'),
  notificationHubService: require('./services/notificationHubService'),
  fileLogger: require('./services/fileLogger'),
  remoteAccessService: require('./services/remoteAccessService'),
  strategyEngine: require('./services/strategyEngine'),
  economicCalendarService: require('./services/economicCalendarService'),
  resourceMonitorService: require('./services/resourceMonitorService'),
  dataSyncSchedulerService: require('./services/dataSyncSchedulerService'),
  runtimeHeartbeatService: require('./services/runtimeHeartbeatService'),
  symbolCustomPaperRuntimeService: require('./services/symbolCustomPaperRuntimeService'),
  symbolCustomLiveRuntimeService: require('./services/symbolCustomLiveRuntimeService'),
  symbolCustomPaperCandleProviderService: require('./services/symbolCustomPaperCandleProviderService')
}));

// Install persistent file logging (console.log/warn/error -> logs/system.log,
// logs/error.log). Console output is preserved.
bootProfiler.measure('logging:init', () => fileLogger.install());

// Load env vars
bootProfiler.measure('env:load', () => {
  const envPath = path.resolve(process.cwd(), '.env');
  const envExamplePath = path.resolve(process.cwd(), '.env.example');

  if (!fs.existsSync(envPath)) {
    console.warn('[WARNING] .env file not found.');
    if (fs.existsSync(envExamplePath)) {
      fs.copyFileSync(envExamplePath, envPath);
      console.log('[INFO] Created .env from .env.example. Please edit it with your actual settings.');
    } else {
      console.warn('[WARNING] .env.example not found either. Using default values.');
    }
  }

  dotenv.config();

  // Set default JWT secrets if not provided (for first-time startup)
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'your-super-secret-jwt-key-change-this') {
    const crypto = require('crypto');
    process.env.JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
    console.warn('[WARNING] Using default/generated JWT_SECRET. Please set a proper one in .env file.');
  }
  if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET === 'your-refresh-secret-key-change-this') {
    const crypto = require('crypto');
    process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || crypto.randomBytes(32).toString('hex');
    console.warn('[WARNING] Using default/generated JWT_REFRESH_SECRET. Please set a proper one in .env file.');
  }
});

// Initialize notification service
bootProfiler.measure('notification:init', () => notificationService.init());

const app = express();
const trustProxy = remoteAccessService.getTrustProxySetting();

if (trustProxy) {
  app.set('trust proxy', trustProxy);
}

// Body parser
app.use(express.json());

// Enable CORS
app.use(cors());

// Prevent the single-page dashboard HTML from getting stuck in browser cache.
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});

// Serve frontend static files
const publicPath = bootProfiler.measure('static:init', () => {
  const resolvedPublicPath = path.resolve(process.cwd(), 'public');
  if (!fs.existsSync(resolvedPublicPath)) {
    fs.mkdirSync(resolvedPublicPath, { recursive: true });
  }
  app.use(express.static(resolvedPublicPath));
  return resolvedPublicPath;
});

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
});

bootProfiler.measure('routes:init', () => {
  // Routes
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/trading', tradingRoutes);
  app.use('/api/positions', positionRoutes);
  app.use('/api/trades', tradeRoutes);
  app.use('/api/strategies', strategyRoutes);
  app.use('/api/strategy-instances', strategyInstanceRoutes);
  app.use('/api/symbol-playbooks', symbolPlaybookRoutes);
  app.use('/api/symbol-customs', symbolCustomRoutes);
  app.use('/api/backtest', backtestRoutes);
  app.use('/api/optimizer', optimizerRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/paper-trading', paperTradingRoutes);
  app.use('/api/risk-settings', riskSettingsRoutes);
  app.use('/api/diagnostics', diagnosticsRoutes);
  app.use('/api/maintenance', maintenanceRoutes);
  app.use('/api/data-sync', dataSyncRoutes);
  app.use('/api/system', systemRoutes);

  // WebSocket status endpoint
  app.get('/api/ws/status', protect, (req, res) => {
    res.json({
      success: true,
      data: {
        clients: websocketService.getClientCount(),
        clientsInfo: websocketService.getClientsInfo(),
      },
    });
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({
      success: true,
      message: 'Server is running',
      wsClients: websocketService.getClientCount(),
      notifications: notificationService.getStatus(),
      resources: {
        memory: resourceMonitorService.getProcessMemory(),
      },
    });
  });
});

// Serve frontend for all non-API routes (SPA fallback)
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(publicPath, 'index.html'));
  } else {
    res.status(404).json({ success: false, message: 'Route not found' });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
});

const PORT = process.env.PORT || 5000;
let server = null;

function handleServerError(err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} is already in use.`);
    console.error(`[Server] If QuantMatrix is already running, open http://localhost:${PORT} in your browser.`);
    console.error('[Server] Otherwise stop the process using this port, or change PORT in .env.');
    process.exit(1);
  }

  console.error('[Server] Failed to start:', err.message);
  process.exit(1);
}

async function startServer() {
  if (server) {
    return server;
  }

  try {
    await bootProfiler.measureAsync('db:init', async () => connectDB());
    await bootProfiler.measureAsync('runtime:init', async () => {
      await Strategy.initDefaults(strategyEngine.getStrategiesInfo());
      await StrategyInstance.migrateFromLegacy();
      await StrategyInstance.migrateScopedEnabledDefaults();
      try {
        await economicCalendarService.ensureCalendar();
      } catch (e) {
        console.warn('[EconCalendar] initial fetch failed:', e.message);
      }
      economicCalendarService.scheduleDaily();
    });

    server = app.listen(PORT, () => {
      bootProfiler.mark('server:listening');
      console.log(`Server running on port ${PORT}`);
      console.log(`Dashboard: http://localhost:${PORT}`);

      bootProfiler.measure('websocket:init', () => websocketService.init(server));
      bootProfiler.measure('notificationHub:init', () => {
        try {
          notificationHubService.start().catch((error) => {
            console.error(`[NotificationHub] Failed to start: ${error.message}`);
          });
        } catch (error) {
          console.error(`[NotificationHub] Failed to start: ${error.message}`);
        }
      });
      bootProfiler.measure('dataSync:init', () => {
        try {
          dataSyncSchedulerService.start();
        } catch (error) {
          console.error(`[DataSync] Scheduler failed to start: ${error.message}`);
        }
      });

      bootProfiler.measure('symbolCustom:init', () => {
        if (process.env.SYMBOL_CUSTOM_PAPER_ENABLED === 'true') {
          try {
            symbolCustomPaperRuntimeService.start({
              getCandlesFn: symbolCustomPaperCandleProviderService.getSymbolCustomPaperCandles,
            });
            console.log('[SymbolCustom] Paper runtime started');
          } catch (error) {
            console.error(`[SymbolCustom] Paper runtime failed to start: ${error.message}`);
          }
        } else {
          console.log('[SymbolCustom] Paper runtime disabled');
        }
        if (process.env.SYMBOL_CUSTOM_LIVE_ENABLED === 'true') {
          try {
            symbolCustomLiveRuntimeService.start({
              getCandlesFn: symbolCustomPaperCandleProviderService.getSymbolCustomPaperCandles,
            });
            console.log('[SymbolCustom] Live runtime started');
          } catch (error) {
            console.error(`[SymbolCustom] Live runtime failed to start: ${error.message}`);
          }
        } else {
          console.log('[SymbolCustom] Live runtime disabled');
        }
      });
      bootProfiler.measure('heartbeat:init', () => {
        try {
          runtimeHeartbeatService.start();
        } catch (error) {
          console.error(`[Heartbeat] Failed to start: ${error.message}`);
        }
      });
      bootProfiler.mark('boot:complete');
    });

    server.on('error', handleServerError);
    return server;
  } catch (error) {
    console.error('[Server] Startup failed:', error.message);
    process.exit(1);
  }
}

startServer();

async function shutdown(signal) {
  console.log(`[Server] ${signal} received, shutting down...`);
  try {
    await runtimeHeartbeatService.notifyServerStopping(signal);
  } catch (error) {
    console.warn(`[Heartbeat] Failed to send server stopping alert: ${error.message}`);
  }
  runtimeHeartbeatService.stop();
  notificationHubService.stop();
  dataSyncSchedulerService.stop();
  symbolCustomPaperRuntimeService.stop();
  symbolCustomLiveRuntimeService.stop();
  websocketService.shutdown();
  if (!server) {
    process.exit(0);
    return;
  }
  server.close(() => process.exit(0));
}

// Graceful shutdown
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

module.exports = {
  app,
  startServer,
  get server() {
    return server;
  },
};
