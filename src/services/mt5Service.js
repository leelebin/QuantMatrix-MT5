/**
 * MT5 Connection Service
 * Manages connection to MetaTrader 5 via Python bridge (direct broker connection)
 */

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

class MT5Service {
  constructor() {
    this.process = null;
    this.connected = false;
    this.ready = false;
    this._pendingRequests = new Map();
    this._requestId = 0;
    this._rl = null;
  }

  /**
   * Start the Python bridge process
   */
  _startBridge() {
    return new Promise((resolve, reject) => {
      const bridgePath = path.resolve(process.cwd(), 'mt5_bridge.py');
      const pythonCmd = process.env.PYTHON_PATH || 'python';

      this.process = spawn(pythonCmd, [bridgePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this._rl = readline.createInterface({ input: this.process.stdout });

      // Handle responses from Python bridge
      this._rl.on('line', (line) => {
        try {
          const response = JSON.parse(line);

          // Handle ready signal
          if (response.id === 'ready') {
            this.ready = true;
            resolve();
            return;
          }

          // Handle command responses
          const pending = this._pendingRequests.get(response.id);
          if (pending) {
            this._pendingRequests.delete(response.id);
            if (response.success) {
              pending.resolve(response.result);
            } else {
              pending.reject(new Error(response.error));
            }
          }
        } catch (e) {
          console.error('[MT5 Bridge] Failed to parse response:', line);
        }
      });

      // Log stderr from Python bridge
      this.process.stderr.on('data', (data) => {
        console.error('[MT5 Bridge]', data.toString().trim());
      });

      this.process.on('error', (err) => {
        console.error('[MT5 Bridge] Process error:', err.message);
        this.connected = false;
        this.ready = false;
        if (!this.ready) {
          reject(new Error(`Failed to start MT5 bridge: ${err.message}`));
        }
      });

      this.process.on('exit', (code) => {
        console.log(`[MT5 Bridge] Process exited with code ${code}`);
        this.connected = false;
        this.ready = false;

        // Reject all pending requests
        for (const [id, pending] of this._pendingRequests) {
          pending.reject(new Error('MT5 bridge process exited'));
        }
        this._pendingRequests.clear();
      });

      // Timeout for bridge startup
      setTimeout(() => {
        if (!this.ready) {
          reject(new Error('MT5 bridge startup timeout. Ensure Python and MetaTrader5 package are installed.'));
        }
      }, 15000);
    });
  }

  /**
   * Send a command to the Python bridge
   */
  _sendCommand(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.ready) {
        reject(new Error('MT5 bridge not started'));
        return;
      }

      const id = String(++this._requestId);
      const command = JSON.stringify({ id, method, params }) + '\n';

      this._pendingRequests.set(id, { resolve, reject });

      // Timeout for individual commands
      const timeout = setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error(`MT5 command timeout: ${method}`));
        }
      }, 30000);

      // Wrap resolve/reject to clear timeout
      const origResolve = this._pendingRequests.get(id).resolve;
      const origReject = this._pendingRequests.get(id).reject;
      this._pendingRequests.set(id, {
        resolve: (val) => { clearTimeout(timeout); origResolve(val); },
        reject: (err) => { clearTimeout(timeout); origReject(err); },
      });

      this.process.stdin.write(command);
    });
  }

  async connect() {
    const login = process.env.MT5_LOGIN;
    const password = process.env.MT5_PASSWORD;
    const server = process.env.MT5_SERVER;

    if (!login) {
      throw new Error('MT5_LOGIN not configured in .env');
    }
    if (!password) {
      throw new Error('MT5_PASSWORD not configured in .env');
    }
    if (!server) {
      throw new Error('MT5_SERVER not configured in .env');
    }

    // Start the Python bridge if not running
    if (!this.ready) {
      console.log('[MT5] Starting Python bridge...');
      await this._startBridge();
      console.log('[MT5] Python bridge ready');
    }

    // Connect to MT5 with broker credentials
    console.log(`[MT5] Connecting to ${server} with login ${login}...`);
    await this._sendCommand('connect', {
      login,
      password,
      server,
      path: process.env.MT5_PATH || null,
    });

    this.connected = true;
    console.log('[MT5] Connected successfully');
    return true;
  }

  async disconnect() {
    if (this.ready) {
      try {
        await this._sendCommand('disconnect');
      } catch (e) {
        // Ignore disconnect errors
      }
    }

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }

    this.connected = false;
    this.ready = false;
    console.log('[MT5] Disconnected');
  }

  isConnected() {
    return this.connected;
  }

  async getAccountInfo() {
    this._ensureConnected();
    return await this._sendCommand('getAccountInfo');
  }

  async getPositions() {
    this._ensureConnected();
    return await this._sendCommand('getPositions');
  }

  async getOrders() {
    this._ensureConnected();
    return await this._sendCommand('getOrders');
  }

  /**
   * Place a market order
   * @param {string} symbol - Trading symbol
   * @param {string} type - 'BUY' or 'SELL'
   * @param {number} volume - Lot size
   * @param {number} stopLoss - Stop loss price
   * @param {number} takeProfit - Take profit price
   * @param {string} comment - Order comment
   */
  async placeOrder(symbol, type, volume, stopLoss, takeProfit, comment = '') {
    this._ensureConnected();

    const result = await this._sendCommand('placeOrder', {
      symbol,
      type,
      volume,
      sl: stopLoss,
      tp: takeProfit,
      comment: comment || `QM-${type}-${symbol}`,
    });

    console.log(`[MT5] Order placed: ${type} ${volume} ${symbol} | SL: ${stopLoss} TP: ${takeProfit}`);
    return result;
  }

  /**
   * Close a position
   * @param {string} positionId - MT5 position ID
   */
  async closePosition(positionId) {
    this._ensureConnected();
    const result = await this._sendCommand('closePosition', { positionId });
    console.log(`[MT5] Position closed: ${positionId}`);
    return result;
  }

  /**
   * Modify position stop loss / take profit
   * @param {string} positionId - MT5 position ID
   * @param {number} stopLoss - New stop loss
   * @param {number} takeProfit - New take profit
   */
  async modifyPosition(positionId, stopLoss, takeProfit) {
    this._ensureConnected();
    return await this._sendCommand('modifyPosition', {
      positionId,
      sl: stopLoss,
      tp: takeProfit,
    });
  }

  /**
   * Get historical candles
   * @param {string} symbol - Trading symbol
   * @param {string} timeframe - e.g. '1h', '4h', '1d'
   * @param {Date} startTime - Start date
   * @param {number} limit - Number of candles
   */
  async getCandles(symbol, timeframe, startTime, limit = 500) {
    this._ensureConnected();
    return await this._sendCommand('getCandles', {
      symbol,
      timeframe,
      startTime: startTime instanceof Date ? startTime.toISOString() : startTime,
      limit,
    });
  }

  /**
   * Get current price for a symbol
   * @param {string} symbol - Trading symbol
   */
  async getPrice(symbol) {
    this._ensureConnected();
    return await this._sendCommand('getPrice', { symbol });
  }

  /**
   * Get deal history (closed trades)
   * @param {Date} startTime - Start date
   * @param {Date} endTime - End date
   */
  async getDeals(startTime, endTime) {
    this._ensureConnected();
    return await this._sendCommand('getDeals', {
      startTime: startTime instanceof Date ? startTime.toISOString() : startTime,
      endTime: endTime instanceof Date ? endTime.toISOString() : endTime,
    });
  }

  _ensureConnected() {
    if (!this.connected) {
      throw new Error('MT5 not connected. Call connect() first.');
    }
  }
}

// Singleton instance
const mt5Service = new MT5Service();

module.exports = mt5Service;
