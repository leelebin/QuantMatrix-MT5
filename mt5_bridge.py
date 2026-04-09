"""
MT5 Bridge - Python bridge for direct MetaTrader 5 connection
Communicates with Node.js via stdin/stdout JSON-line protocol
"""

import sys
import json
import traceback
from datetime import datetime, timezone

try:
    import MetaTrader5 as mt5
except ImportError:
    print(json.dumps({
        "id": "init",
        "success": False,
        "error": "MetaTrader5 package not installed. Run: pip install MetaTrader5"
    }), flush=True)
    sys.exit(1)


def get_filling_mode(symbol):
    """Auto-detect the supported filling mode for a symbol/broker.
    Checks symbol_info.filling_mode bitmask and returns the first supported type.
    """
    info = mt5.symbol_info(symbol)
    if info is None:
        return mt5.ORDER_FILLING_IOC  # fallback

    filling = info.filling_mode
    # Bit 1 = FOK, Bit 2 = IOC, Bit 4 = RETURN (broker-dependent)
    if filling & 1:
        return mt5.ORDER_FILLING_FOK
    if filling & 2:
        return mt5.ORDER_FILLING_IOC
    # RETURN is the most permissive - works on most brokers as fallback
    return mt5.ORDER_FILLING_RETURN


# Timeframe mapping from string to MT5 constants
TIMEFRAME_MAP = {
    "1m": mt5.TIMEFRAME_M1,
    "5m": mt5.TIMEFRAME_M5,
    "15m": mt5.TIMEFRAME_M15,
    "30m": mt5.TIMEFRAME_M30,
    "1h": mt5.TIMEFRAME_H1,
    "2h": mt5.TIMEFRAME_H2,
    "4h": mt5.TIMEFRAME_H4,
    "6h": mt5.TIMEFRAME_H6,
    "8h": mt5.TIMEFRAME_H8,
    "12h": mt5.TIMEFRAME_H12,
    "1d": mt5.TIMEFRAME_D1,
    "1w": mt5.TIMEFRAME_W1,
    "1mn": mt5.TIMEFRAME_MN1,
}


def handle_connect(params):
    """Initialize MT5 connection with broker credentials"""
    login = int(params["login"])
    password = str(params["password"])
    server = str(params["server"])
    path = params.get("path")

    init_params = {
        "login": login,
        "password": password,
        "server": server,
    }
    if path:
        init_params["path"] = path

    if not mt5.initialize(**init_params):
        error = mt5.last_error()
        return {"success": False, "error": f"MT5 initialize failed: {error}"}

    return {"success": True, "result": True}


def handle_disconnect(_params):
    """Shutdown MT5 connection"""
    mt5.shutdown()
    return {"success": True, "result": True}


def handle_get_account_info(_params):
    """Get account information"""
    info = mt5.account_info()
    if info is None:
        return {"success": False, "error": f"Failed to get account info: {mt5.last_error()}"}

    return {"success": True, "result": {
        "balance": info.balance,
        "equity": info.equity,
        "currency": info.currency,
        "leverage": info.leverage,
        "margin": info.margin,
        "freeMargin": info.margin_free,
        "profit": info.profit,
        "login": info.login,
        "server": info.server,
        "name": info.name,
        "tradeAllowed": info.trade_allowed,
    }}


def handle_get_positions(_params):
    """Get all open positions"""
    positions = mt5.positions_get()
    if positions is None:
        # No positions or error
        error = mt5.last_error()
        if error[0] != 0:
            return {"success": False, "error": f"Failed to get positions: {error}"}
        return {"success": True, "result": []}

    result = []
    for p in positions:
        result.append({
            "id": str(p.ticket),
            "symbol": p.symbol,
            "type": "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL",
            "volume": p.volume,
            "openPrice": p.price_open,
            "stopLoss": p.sl,
            "takeProfit": p.tp,
            "currentPrice": p.price_current,
            "profit": p.profit,
            "swap": p.swap,
            "comment": p.comment,
            "magic": p.magic,
            "time": int(p.time),
        })

    return {"success": True, "result": result}


def handle_get_orders(_params):
    """Get pending orders"""
    orders = mt5.orders_get()
    if orders is None:
        error = mt5.last_error()
        if error[0] != 0:
            return {"success": False, "error": f"Failed to get orders: {error}"}
        return {"success": True, "result": []}

    result = []
    for o in orders:
        result.append({
            "id": str(o.ticket),
            "symbol": o.symbol,
            "type": o.type,
            "volume": o.volume_current,
            "openPrice": o.price_open,
            "stopLoss": o.sl,
            "takeProfit": o.tp,
            "currentPrice": o.price_current,
            "comment": o.comment,
        })

    return {"success": True, "result": result}


def handle_place_order(params):
    """Place a market order"""
    symbol = params["symbol"]
    order_type = params["type"]  # "BUY" or "SELL"
    volume = float(params["volume"])
    sl = float(params.get("sl", 0))
    tp = float(params.get("tp", 0))
    comment = params.get("comment", "")

    # Ensure symbol is available
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        return {"success": False, "error": f"Symbol {symbol} not found"}
    if not symbol_info.visible:
        if not mt5.symbol_select(symbol, True):
            return {"success": False, "error": f"Failed to select symbol {symbol}"}

    # Get current price
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"success": False, "error": f"Failed to get price for {symbol}"}

    if order_type == "BUY":
        mt5_type = mt5.ORDER_TYPE_BUY
        price = tick.ask
    else:
        mt5_type = mt5.ORDER_TYPE_SELL
        price = tick.bid

    # Enforce minimum stop distance required by broker
    digits = symbol_info.digits
    point = symbol_info.point
    spread = symbol_info.spread * point
    # Use stops_level + spread + generous buffer to avoid retcode=10016
    min_stop_dist = max(symbol_info.trade_stops_level * point * 3, spread * 5, point * 50)

    if sl != 0:
        if order_type == "BUY" and (price - sl) < min_stop_dist:
            sl = round(price - min_stop_dist, digits)
        elif order_type == "SELL" and (sl - price) < min_stop_dist:
            sl = round(price + min_stop_dist, digits)

    if tp != 0:
        if order_type == "BUY" and (tp - price) < min_stop_dist:
            tp = round(price + min_stop_dist * 2, digits)
        elif order_type == "SELL" and (price - tp) < min_stop_dist:
            tp = round(price - min_stop_dist * 2, digits)

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5_type,
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": 20,
        "magic": 202400,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": get_filling_mode(symbol),
    }

    result = mt5.order_send(request)
    if result is None:
        return {"success": False, "error": f"Order send failed: {mt5.last_error()}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": f"Order failed: retcode={result.retcode}, comment={result.comment}"}

    return {"success": True, "result": {
        "positionId": str(result.order),
        "orderId": str(result.order),
        "deal": str(result.deal),
        "volume": result.volume,
        "price": result.price,
    }}


def handle_close_position(params):
    """Close an open position"""
    position_id = int(params["positionId"])

    # Find the position
    positions = mt5.positions_get(ticket=position_id)
    if positions is None or len(positions) == 0:
        return {"success": False, "error": f"Position {position_id} not found"}

    position = positions[0]
    symbol = position.symbol
    volume = position.volume

    # Determine close type (opposite of position type)
    if position.type == mt5.ORDER_TYPE_BUY:
        close_type = mt5.ORDER_TYPE_SELL
        tick = mt5.symbol_info_tick(symbol)
        price = tick.bid if tick else 0
    else:
        close_type = mt5.ORDER_TYPE_BUY
        tick = mt5.symbol_info_tick(symbol)
        price = tick.ask if tick else 0

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": close_type,
        "position": position_id,
        "price": price,
        "deviation": 20,
        "magic": 202400,
        "comment": "close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": get_filling_mode(symbol),
    }

    result = mt5.order_send(request)
    if result is None:
        return {"success": False, "error": f"Close failed: {mt5.last_error()}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": f"Close failed: retcode={result.retcode}, comment={result.comment}"}

    return {"success": True, "result": {
        "orderId": str(result.order),
        "volume": result.volume,
        "price": result.price,
    }}


def handle_modify_position(params):
    """Modify position stop loss / take profit"""
    position_id = int(params["positionId"])
    sl = float(params.get("sl", 0))
    tp = float(params.get("tp", 0))

    # Find the position to get symbol
    positions = mt5.positions_get(ticket=position_id)
    if positions is None or len(positions) == 0:
        return {"success": False, "error": f"Position {position_id} not found"}

    position = positions[0]

    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": position.symbol,
        "position": position_id,
        "sl": sl,
        "tp": tp,
    }

    result = mt5.order_send(request)
    if result is None:
        return {"success": False, "error": f"Modify failed: {mt5.last_error()}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"success": False, "error": f"Modify failed: retcode={result.retcode}, comment={result.comment}"}

    return {"success": True, "result": True}


def handle_get_candles(params):
    """Get historical candles"""
    symbol = params["symbol"]
    timeframe_str = params.get("timeframe", "1h")
    limit = int(params.get("limit", 500))
    start_time = params.get("startTime")

    tf = TIMEFRAME_MAP.get(timeframe_str)
    if tf is None:
        return {"success": False, "error": f"Unknown timeframe: {timeframe_str}"}

    # Ensure symbol is selected
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        return {"success": False, "error": f"Symbol {symbol} not found"}
    if not symbol_info.visible:
        mt5.symbol_select(symbol, True)

    if start_time:
        # Parse ISO date string
        try:
            dt = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            dt = datetime.fromtimestamp(int(start_time) / 1000, tz=timezone.utc)

        rates = mt5.copy_rates_from(symbol, tf, dt, limit)
    else:
        rates = mt5.copy_rates_from_pos(symbol, tf, 0, limit)

    if rates is None or len(rates) == 0:
        error = mt5.last_error()
        return {"success": False, "error": f"Failed to get candles for {symbol}: {error}"}

    candles = []
    for r in rates:
        candles.append({
            "time": datetime.fromtimestamp(r[0], tz=timezone.utc).isoformat(),
            "open": float(r[1]),
            "high": float(r[2]),
            "low": float(r[3]),
            "close": float(r[4]),
            "tickVolume": int(r[5]),
            "spread": int(r[6]),
            "volume": int(r[7]),
        })

    return {"success": True, "result": candles}


def handle_get_price(params):
    """Get current price for a symbol"""
    symbol = params["symbol"]

    # Ensure symbol is selected
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        return {"success": False, "error": f"Symbol {symbol} not found"}
    if not symbol_info.visible:
        mt5.symbol_select(symbol, True)

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"success": False, "error": f"Failed to get price for {symbol}: {mt5.last_error()}"}

    return {"success": True, "result": {
        "bid": tick.bid,
        "ask": tick.ask,
        "last": tick.last,
        "time": datetime.fromtimestamp(tick.time, tz=timezone.utc).isoformat(),
    }}


def handle_get_deals(params):
    """Get deal history"""
    start_time = params.get("startTime")
    end_time = params.get("endTime")

    try:
        dt_from = datetime.fromisoformat(start_time.replace("Z", "+00:00")) if start_time else datetime(2020, 1, 1, tzinfo=timezone.utc)
        dt_to = datetime.fromisoformat(end_time.replace("Z", "+00:00")) if end_time else datetime.now(timezone.utc)
    except (ValueError, AttributeError):
        dt_from = datetime(2020, 1, 1, tzinfo=timezone.utc)
        dt_to = datetime.now(timezone.utc)

    deals = mt5.history_deals_get(dt_from, dt_to)
    if deals is None:
        error = mt5.last_error()
        if error[0] != 0:
            return {"success": False, "error": f"Failed to get deals: {error}"}
        return {"success": True, "result": []}

    result = []
    for d in deals:
        result.append({
            "id": str(d.ticket),
            "orderId": str(d.order),
            "positionId": str(d.position_id),
            "symbol": d.symbol,
            "type": d.type,
            "volume": d.volume,
            "price": d.price,
            "profit": d.profit,
            "swap": d.swap,
            "commission": d.commission,
            "comment": d.comment,
            "time": datetime.fromtimestamp(d.time, tz=timezone.utc).isoformat(),
        })

    return {"success": True, "result": result}


# Command dispatcher
HANDLERS = {
    "connect": handle_connect,
    "disconnect": handle_disconnect,
    "getAccountInfo": handle_get_account_info,
    "getPositions": handle_get_positions,
    "getOrders": handle_get_orders,
    "placeOrder": handle_place_order,
    "closePosition": handle_close_position,
    "modifyPosition": handle_modify_position,
    "getCandles": handle_get_candles,
    "getPrice": handle_get_price,
    "getDeals": handle_get_deals,
}


def main():
    """Main loop: read JSON commands from stdin, execute, write results to stdout"""
    # Signal ready
    print(json.dumps({"id": "ready", "success": True, "result": "MT5 bridge ready"}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"id": None, "success": False, "error": f"Invalid JSON: {e}"}), flush=True)
            continue

        cmd_id = cmd.get("id")
        method = cmd.get("method")
        params = cmd.get("params", {})

        handler = HANDLERS.get(method)
        if not handler:
            print(json.dumps({"id": cmd_id, "success": False, "error": f"Unknown method: {method}"}), flush=True)
            continue

        try:
            response = handler(params)
            response["id"] = cmd_id
            print(json.dumps(response), flush=True)
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            print(json.dumps({"id": cmd_id, "success": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
