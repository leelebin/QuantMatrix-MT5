/**
 * WebSocket Service
 * Real-time communication with frontend clients
 *
 * Features:
  * - Heartbeat detection (ping/pong every 30s)
 * - Authenticated connection tracking with metadata
 * - Topic-based broadcasting (positions, trades, signals, account, status)
 * - Disconnect logging with reasons
 */

const WebSocket = require('ws');
const { authenticateAccessToken } = require('../middleware/auth');

class WebSocketService {
  constructor() {
    this.wss = null;
    this.clients = new Map(); // ws -> { id, authenticated, subscribedTopics, lastPong, connectedAt }
    this.heartbeatInterval = null;
    this.clientIdCounter = 0;
    this.HEARTBEAT_INTERVAL = 30000; // 30 seconds
    this.PONG_TIMEOUT = 10000; // 10 seconds to respond
    this.DEFAULT_TOPICS = ['positions', 'trades', 'signals', 'account', 'status', 'notifications', 'diagnostics'];
  }

  /**
   * Initialize WebSocket server on existing HTTP server
   * @param {http.Server} server - HTTP server instance
   */
  init(server) {
    this.wss = new WebSocket.Server({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      const clientId = ++this.clientIdCounter;
      const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      const clientIp = forwardedFor || req.socket.remoteAddress;

      this.clients.set(ws, {
        id: clientId,
        ip: clientIp,
        authenticated: false,
        user: null,
        subscribedTopics: new Set(),
        lastPong: Date.now(),
        connectedAt: new Date().toISOString(),
      });

      console.log(`[WS] Client #${clientId} connected from ${clientIp} (total: ${this.clients.size})`);

      // Handle incoming messages
      ws.on('message', (message) => {
        this._handleMessage(ws, message);
      });

      // Handle pong response
      ws.on('pong', () => {
        const client = this.clients.get(ws);
        if (client) {
          client.lastPong = Date.now();
        }
      });

      // Handle client disconnect
      ws.on('close', (code, reason) => {
        const client = this.clients.get(ws);
        const reasonStr = reason ? reason.toString() : 'unknown';
        console.log(
          `[WS] Client #${client ? client.id : '?'} disconnected | code: ${code} | reason: ${reasonStr} | duration: ${client ? this._getDuration(client.connectedAt) : '?'}`
        );
        this.clients.delete(ws);
      });

      // Handle errors
      ws.on('error', (err) => {
        const client = this.clients.get(ws);
        console.error(`[WS] Client #${client ? client.id : '?'} error: ${err.message}`);
        this.clients.delete(ws);
      });
    });

    // Start heartbeat checker
    this._startHeartbeat();

    console.log('[WS] WebSocket server initialized on /ws');
  }

  /**
   * Handle incoming client messages
   */
  _handleMessage(ws, rawMessage) {
    try {
      const message = JSON.parse(rawMessage.toString());
      const client = this.clients.get(ws);
      if (!client) return;

      switch (message.type) {
        case 'auth':
          this._authenticateClient(ws, message.token);
          break;

        case 'subscribe':
          if (!client.authenticated) {
            this._send(ws, {
              type: 'auth_required',
              data: { message: 'Authenticate before subscribing to updates' },
            });
            break;
          }

          // Subscribe to specific topics
          if (Array.isArray(message.topics)) {
            message.topics
              .filter((topic) => this.DEFAULT_TOPICS.includes(topic))
              .forEach((topic) => client.subscribedTopics.add(topic));
            this._send(ws, {
              type: 'subscribed',
              data: { topics: Array.from(client.subscribedTopics) },
            });
          }
          break;

        case 'unsubscribe':
          if (!client.authenticated) {
            this._send(ws, {
              type: 'auth_required',
              data: { message: 'Authenticate before unsubscribing from updates' },
            });
            break;
          }

          if (Array.isArray(message.topics)) {
            message.topics.forEach((t) => client.subscribedTopics.delete(t));
            this._send(ws, {
              type: 'unsubscribed',
              data: { topics: Array.from(client.subscribedTopics) },
            });
          }
          break;

        case 'ping':
          if (client.authenticated) {
            // Client-initiated ping (in addition to WebSocket protocol ping/pong)
            this._send(ws, { type: 'pong', data: { timestamp: Date.now() } });
          }
          break;

        case 'getTopics':
          if (!client.authenticated) {
            this._send(ws, {
              type: 'auth_required',
              data: { message: 'Authenticate before requesting topics' },
            });
            break;
          }

          this._send(ws, {
            type: 'topics',
            data: { topics: Array.from(client.subscribedTopics) },
          });
          break;

        default:
          this._send(ws, {
            type: 'error',
            data: { message: `Unknown message type: ${message.type}` },
          });
      }
    } catch (err) {
      this._send(ws, {
        type: 'error',
        data: { message: 'Invalid JSON message' },
      });
    }
  }

  async _authenticateClient(ws, token) {
    const client = this.clients.get(ws);
    if (!client) return;

    try {
      const user = await authenticateAccessToken(token);
      client.authenticated = true;
      client.user = {
        id: user._id || user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      };
      client.lastAuthenticatedAt = new Date().toISOString();

      this._send(ws, {
        type: 'authenticated',
        data: {
          clientId: client.id,
          message: 'Connected to QuantMatrix WebSocket',
          availableTopics: this.DEFAULT_TOPICS,
          user: client.user,
        },
      });
    } catch (err) {
      this._send(ws, {
        type: 'auth_failed',
        data: {
          message: err.message || 'Authentication failed',
        },
      });

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(4401, 'Authentication failed');
      }
    }
  }

  /**
   * Start heartbeat interval - ping clients every 30s
   */
  _startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();

      for (const [ws, client] of this.clients) {
        // Check if client missed the last pong
        if (now - client.lastPong > this.HEARTBEAT_INTERVAL + this.PONG_TIMEOUT) {
          console.log(
            `[WS] Client #${client.id} heartbeat timeout (last pong: ${Math.round((now - client.lastPong) / 1000)}s ago) - terminating`
          );
          ws.terminate();
          this.clients.delete(ws);
          continue;
        }

        // Send ping
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }

  /**
   * Broadcast event to all subscribed clients
   * @param {string} topic - Event topic (positions, trades, signals, account, status)
   * @param {string} eventType - Specific event type
   * @param {object} data - Event data
   */
  broadcast(topic, eventType, data) {
    if (!this.wss) return;

    const message = {
      type: eventType,
      topic,
      data,
      timestamp: new Date().toISOString(),
    };

    let sent = 0;
    for (const [ws, client] of this.clients) {
      if (ws.readyState === WebSocket.OPEN && client.authenticated && client.subscribedTopics.has(topic)) {
        this._send(ws, message);
        sent++;
      }
    }

    if (sent > 0) {
      console.log(`[WS] Broadcast ${topic}:${eventType} to ${sent} client(s)`);
    }
  }

  /**
   * Send message to a specific client
   */
  _send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Get connection duration string
   */
  _getDuration(connectedAt) {
    const ms = Date.now() - new Date(connectedAt).getTime();
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  /**
   * Get connected client count
   */
  getClientCount() {
    return this.clients.size;
  }

  /**
   * Get client info for status endpoint
   */
  getClientsInfo() {
    const info = [];
    for (const [, client] of this.clients) {
      info.push({
        id: client.id,
        ip: client.ip,
        authenticated: client.authenticated,
        user: client.user,
        connectedAt: client.connectedAt,
        duration: this._getDuration(client.connectedAt),
        topics: Array.from(client.subscribedTopics),
        lastPong: new Date(client.lastPong).toISOString(),
      });
    }
    return info;
  }

  /**
   * Shutdown WebSocket server
   */
  shutdown() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.wss) {
      for (const [ws] of this.clients) {
        ws.close(1001, 'Server shutting down');
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
    }

    console.log('[WS] WebSocket server shut down');
  }
}

// Singleton
const websocketService = new WebSocketService();

module.exports = websocketService;
