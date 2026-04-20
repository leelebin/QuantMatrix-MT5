const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const connectDB = require('./config/db');
const authRoutes = require('./routes/authRoutes');
const userRoutes = require('./routes/userRoutes');
const tradingRoutes = require('./routes/tradingRoutes');
const positionRoutes = require('./routes/positionRoutes');
const tradeRoutes = require('./routes/tradeRoutes');
const strategyRoutes = require('./routes/strategyRoutes');
const backtestRoutes = require('./routes/backtestRoutes');
const optimizerRoutes = require('./routes/optimizerRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const paperTradingRoutes = require('./routes/paperTradingRoutes');
const riskSettingsRoutes = require('./routes/riskSettingsRoutes');
const diagnosticsRoutes = require('./routes/diagnosticsRoutes');
const websocketService = require('./services/websocketService');
const notificationService = require('./services/notificationService');
const fileLogger = require('./services/fileLogger');

// Install persistent file logging (console.log/warn/error -> logs/system.log,
// logs/error.log). Console output is preserved.
fileLogger.install();

// Load env vars
const path = require('path');
const fs = require('fs');
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

// Connect to database
connectDB();

// Initialize notification service
notificationService.init();

const app = express();

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
const publicPath = path.resolve(process.cwd(), 'public');
if (!fs.existsSync(publicPath)) {
  fs.mkdirSync(publicPath, { recursive: true });
}
app.use(express.static(publicPath));

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: {
    success: false,
    message: 'Too many requests, please try again later',
  },
});

// Routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/positions', positionRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/strategies', strategyRoutes);
app.use('/api/backtest', backtestRoutes);
app.use('/api/optimizer', optimizerRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/paper-trading', paperTradingRoutes);
app.use('/api/risk-settings', riskSettingsRoutes);
app.use('/api/diagnostics', diagnosticsRoutes);

// WebSocket status endpoint
app.get('/api/ws/status', (req, res) => {
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

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);

  // Initialize WebSocket on the HTTP server
  websocketService.init(server);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server] Port ${PORT} is already in use.`);
    console.error(`[Server] If QuantMatrix is already running, open http://localhost:${PORT} in your browser.`);
    console.error('[Server] Otherwise stop the process using this port, or change PORT in .env.');
    process.exit(1);
  }

  console.error('[Server] Failed to start:', err.message);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down...');
  websocketService.shutdown();
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[Server] SIGINT received, shutting down...');
  websocketService.shutdown();
  server.close(() => process.exit(0));
});

module.exports = { app, server };
