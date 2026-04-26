"""
MT5 Bridge - Python bridge for direct MetaTrader 5 connection
Communicates with Node.js via stdin/stdout JSON-line protocol
"""

import sys
import json
import traceback
import os
from datetime import datetime, timedelta, timezone

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

TIMEFRAME_TO_SECONDS = {
    "1m": 60,
    "5m": 5 * 60,
    "15m": 15 * 60,
    "30m": 30 * 60,
    "1h": 60 * 60,
    "2h": 2 * 60 * 60,
    "4h": 4 * 60 * 60,
    "6h": 6 * 60 * 60,
    "8h": 8 * 60 * 60,
    "12h": 12 * 60 * 60,
    "1d": 24 * 60 * 60,
    "1w": 7 * 24 * 60 * 60,
}

# Large minute-range requests can fail with `(-2, "Terminal: Invalid params")`
# on some terminals/brokers. We chunk those requests into smaller date windows
# and stitch the series back together so intraday backtests remain stable.
CHUNKED_RANGE_DAYS_BY_TIMEFRAME = {
    "1m": 30,
    "5m": 90,
}

try:
    STALE_TICK_THRESHOLD_SECONDS = max(0, int(os.getenv("MT5_STALE_TICK_THRESHOLD_SECONDS", "900")))
except ValueError:
    STALE_TICK_THRESHOLD_SECONDS = 900

ACCOUNT_TRADE_MODE_NAMES = {
    getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0): "DEMO",
    getattr(mt5, "ACCOUNT_TRADE_MODE_CONTEST", 1): "CONTEST",
    getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2): "REAL",
}

SYMBOL_TRADE_MODE_NAMES = {
    getattr(mt5, "SYMBOL_TRADE_MODE_DISABLED", 0): "DISABLED",
    getattr(mt5, "SYMBOL_TRADE_MODE_LONGONLY", 1): "LONGONLY",
    getattr(mt5, "SYMBOL_TRADE_MODE_SHORTONLY", 2): "SHORTONLY",
    getattr(mt5, "SYMBOL_TRADE_MODE_CLOSEONLY", 3): "CLOSEONLY",
    getattr(mt5, "SYMBOL_TRADE_MODE_FULL", 4): "FULL",
}

TRADE_RETCODE_NAMES = {
    getattr(mt5, "TRADE_RETCODE_REQUOTE", 10004): "REQUOTE",
    getattr(mt5, "TRADE_RETCODE_REJECT", 10006): "REJECT",
    getattr(mt5, "TRADE_RETCODE_CANCEL", 10007): "CANCEL",
    getattr(mt5, "TRADE_RETCODE_PLACED", 10008): "PLACED",
    getattr(mt5, "TRADE_RETCODE_DONE", 10009): "DONE",
    getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010): "DONE_PARTIAL",
    getattr(mt5, "TRADE_RETCODE_ERROR", 10011): "ERROR",
    getattr(mt5, "TRADE_RETCODE_TIMEOUT", 10012): "TIMEOUT",
    getattr(mt5, "TRADE_RETCODE_INVALID", 10013): "INVALID",
    getattr(mt5, "TRADE_RETCODE_INVALID_VOLUME", 10014): "INVALID_VOLUME",
    getattr(mt5, "TRADE_RETCODE_INVALID_PRICE", 10015): "INVALID_PRICE",
    getattr(mt5, "TRADE_RETCODE_INVALID_STOPS", 10016): "INVALID_STOPS",
    getattr(mt5, "TRADE_RETCODE_TRADE_DISABLED", 10017): "TRADE_DISABLED",
    getattr(mt5, "TRADE_RETCODE_MARKET_CLOSED", 10018): "MARKET_CLOSED",
    getattr(mt5, "TRADE_RETCODE_NO_MONEY", 10019): "NO_MONEY",
    getattr(mt5, "TRADE_RETCODE_PRICE_CHANGED", 10020): "PRICE_CHANGED",
    getattr(mt5, "TRADE_RETCODE_PRICE_OFF", 10021): "PRICE_OFF",
    getattr(mt5, "TRADE_RETCODE_INVALID_EXPIRATION", 10022): "INVALID_EXPIRATION",
    getattr(mt5, "TRADE_RETCODE_ORDER_CHANGED", 10023): "ORDER_CHANGED",
    getattr(mt5, "TRADE_RETCODE_TOO_MANY_REQUESTS", 10024): "TOO_MANY_REQUESTS",
    getattr(mt5, "TRADE_RETCODE_NO_CHANGES", 10025): "NO_CHANGES",
    getattr(mt5, "TRADE_RETCODE_SERVER_DISABLES_AT", 10026): "SERVER_DISABLES_AT",
    getattr(mt5, "TRADE_RETCODE_CLIENT_DISABLES_AT", 10027): "CLIENT_DISABLES_AT",
    getattr(mt5, "TRADE_RETCODE_LOCKED", 10028): "LOCKED",
    getattr(mt5, "TRADE_RETCODE_FROZEN", 10029): "FROZEN",
    getattr(mt5, "TRADE_RETCODE_INVALID_FILL", 10030): "INVALID_FILL",
    getattr(mt5, "TRADE_RETCODE_CONNECTION", 10031): "CONNECTION",
    getattr(mt5, "TRADE_RETCODE_ONLY_REAL", 10032): "ONLY_REAL",
    getattr(mt5, "TRADE_RETCODE_LIMIT_ORDERS", 10033): "LIMIT_ORDERS",
    getattr(mt5, "TRADE_RETCODE_LIMIT_VOLUME", 10034): "LIMIT_VOLUME",
}
if 0 not in TRADE_RETCODE_NAMES:
    TRADE_RETCODE_NAMES[0] = "CHECK_OK"
# If MetaTrader5 already exposes a retcode 0 name, keep that mapping intact.

DEAL_ENTRY_NAMES = {
    getattr(mt5, "DEAL_ENTRY_IN", 0): "IN",
    getattr(mt5, "DEAL_ENTRY_OUT", 1): "OUT",
    getattr(mt5, "DEAL_ENTRY_INOUT", 2): "INOUT",
    getattr(mt5, "DEAL_ENTRY_OUT_BY", 3): "OUT_BY",
}

DEAL_REASON_NAMES = {
    getattr(mt5, "DEAL_REASON_CLIENT", 0): "CLIENT",
    getattr(mt5, "DEAL_REASON_MOBILE", 1): "MOBILE",
    getattr(mt5, "DEAL_REASON_WEB", 2): "WEB",
    getattr(mt5, "DEAL_REASON_EXPERT", 3): "EXPERT",
    getattr(mt5, "DEAL_REASON_SL", 4): "SL",
    getattr(mt5, "DEAL_REASON_TP", 5): "TP",
    getattr(mt5, "DEAL_REASON_SO", 6): "STOP_OUT",
    getattr(mt5, "DEAL_REASON_ROLLOVER", 7): "ROLLOVER",
    getattr(mt5, "DEAL_REASON_VMARGIN", 8): "VMARGIN",
    getattr(mt5, "DEAL_REASON_SPLIT", 9): "SPLIT",
}

DEAL_TYPE_NAMES = {
    getattr(mt5, "DEAL_TYPE_BUY", 0): "BUY",
    getattr(mt5, "DEAL_TYPE_SELL", 1): "SELL",
    getattr(mt5, "DEAL_TYPE_BALANCE", 2): "BALANCE",
    getattr(mt5, "DEAL_TYPE_CREDIT", 3): "CREDIT",
    getattr(mt5, "DEAL_TYPE_CHARGE", 4): "CHARGE",
    getattr(mt5, "DEAL_TYPE_CORRECTION", 5): "CORRECTION",
    getattr(mt5, "DEAL_TYPE_BONUS", 6): "BONUS",
    getattr(mt5, "DEAL_TYPE_COMMISSION", 7): "COMMISSION",
    getattr(mt5, "DEAL_TYPE_COMMISSION_DAILY", 8): "COMMISSION_DAILY",
    getattr(mt5, "DEAL_TYPE_COMMISSION_MONTHLY", 9): "COMMISSION_MONTHLY",
    getattr(mt5, "DEAL_TYPE_COMMISSION_AGENT_DAILY", 10): "COMMISSION_AGENT_DAILY",
    getattr(mt5, "DEAL_TYPE_COMMISSION_AGENT_MONTHLY", 11): "COMMISSION_AGENT_MONTHLY",
    getattr(mt5, "DEAL_TYPE_INTEREST", 12): "INTEREST",
    getattr(mt5, "DEAL_TYPE_BUY_CANCELED", 13): "BUY_CANCELED",
    getattr(mt5, "DEAL_TYPE_SELL_CANCELED", 14): "SELL_CANCELED",
}


def parse_datetime(value, default_value):
    if not value:
        return default_value

    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (ValueError, AttributeError, TypeError):
        try:
            return datetime.fromtimestamp(int(value) / 1000, tz=timezone.utc)
        except (ValueError, TypeError):
            return default_value


def timeframe_step_delta(timeframe_str):
    seconds = TIMEFRAME_TO_SECONDS.get(timeframe_str)
    return timedelta(seconds=seconds) if seconds else timedelta(minutes=1)


def should_chunk_range(timeframe_str, dt_from, dt_to):
    chunk_days = CHUNKED_RANGE_DAYS_BY_TIMEFRAME.get(timeframe_str)
    if not chunk_days:
        return False
    return (dt_to - dt_from) > timedelta(days=chunk_days)


def copy_rates_range_chunked(symbol, tf, dt_from, dt_to, timeframe_str):
    chunk_days = CHUNKED_RANGE_DAYS_BY_TIMEFRAME.get(timeframe_str)
    if not chunk_days:
        return None, None

    cursor = dt_from
    chunk_delta = timedelta(days=chunk_days)
    step_delta = timeframe_step_delta(timeframe_str)
    seen_timestamps = set()
    all_rates = []

    while cursor < dt_to:
        chunk_end = min(cursor + chunk_delta, dt_to)
        chunk_rates = mt5.copy_rates_range(symbol, tf, cursor, chunk_end)
        if chunk_rates is None:
            return None, mt5.last_error()

        if len(chunk_rates) > 0:
            for rate in chunk_rates:
                timestamp = int(rate[0])
                if timestamp in seen_timestamps:
                    continue
                seen_timestamps.add(timestamp)
                all_rates.append(rate)

            last_chunk_time = datetime.fromtimestamp(int(chunk_rates[-1][0]), tz=timezone.utc)
            cursor = max(last_chunk_time + step_delta, chunk_end + step_delta)
        else:
            cursor = chunk_end + step_delta

    return all_rates, None


def sort_deals(deals):
    return sorted(
        deals or [],
        key=lambda deal: (getattr(deal, "time_msc", 0), getattr(deal, "ticket", 0))
    )


def serialize_deal(deal):
    if deal is None:
        return None

    deal_type = getattr(deal, "type", None)
    entry = getattr(deal, "entry", None)
    reason = getattr(deal, "reason", None)

    return {
        "id": str(deal.ticket),
        "orderId": str(deal.order),
        "positionId": str(deal.position_id),
        "symbol": deal.symbol,
        "type": deal_type,
        "typeName": DEAL_TYPE_NAMES.get(deal_type, str(deal_type) if deal_type is not None else None),
        "volume": deal.volume,
        "price": deal.price,
        "profit": deal.profit,
        "swap": deal.swap,
        "commission": deal.commission,
        "fee": getattr(deal, "fee", 0.0),
        "comment": deal.comment,
        "entry": entry,
        "entryName": DEAL_ENTRY_NAMES.get(entry, str(entry) if entry is not None else None),
        "reason": reason,
        "reasonName": DEAL_REASON_NAMES.get(reason, str(reason) if reason is not None else None),
        "time": datetime.fromtimestamp(deal.time, tz=timezone.utc).isoformat(),
        "timeMsc": getattr(deal, "time_msc", 0),
    }


def error_response(message, code=None, details=None):
    response = {"success": False, "error": message}
    if code is not None:
        response["code"] = int(code)
        response["codeName"] = TRADE_RETCODE_NAMES.get(code, str(code))
    if details is not None:
        response["details"] = details
    return response


def get_tick_age_seconds(tick):
    if tick is None:
        return None

    tick_time = datetime.fromtimestamp(tick.time, tz=timezone.utc)
    return max(0, int((datetime.now(timezone.utc) - tick_time).total_seconds()))


def serialize_tick(tick):
    if tick is None:
        return None

    tick_time = datetime.fromtimestamp(tick.time, tz=timezone.utc)
    return {
        "bid": tick.bid,
        "ask": tick.ask,
        "last": tick.last,
        "time": tick_time.isoformat(),
        "timeMsc": getattr(tick, "time_msc", 0),
        "ageSeconds": get_tick_age_seconds(tick),
    }


def serialize_symbol_info(symbol_info, tick=None):
    if symbol_info is None:
        return None

    return {
        "symbol": symbol_info.name,
        "path": getattr(symbol_info, "path", None),
        "visible": symbol_info.visible,
        "tradeMode": symbol_info.trade_mode,
        "tradeModeName": SYMBOL_TRADE_MODE_NAMES.get(symbol_info.trade_mode, str(symbol_info.trade_mode)),
        "spread": symbol_info.spread,
        "digits": symbol_info.digits,
        "point": symbol_info.point,
        "stopsLevel": symbol_info.trade_stops_level,
        "freezeLevel": symbol_info.trade_freeze_level,
        "volumeMin": symbol_info.volume_min,
        "volumeMax": symbol_info.volume_max,
        "volumeStep": symbol_info.volume_step,
        "tradeTickSize": getattr(symbol_info, "trade_tick_size", None),
        "tradeTickValue": getattr(symbol_info, "trade_tick_value", None),
        "tradeTickValueProfit": getattr(symbol_info, "trade_tick_value_profit", None),
        "tradeTickValueLoss": getattr(symbol_info, "trade_tick_value_loss", None),
        "tradeContractSize": getattr(symbol_info, "trade_contract_size", None),
        "currencyBase": getattr(symbol_info, "currency_base", None),
        "currencyProfit": getattr(symbol_info, "currency_profit", None),
        "currencyMargin": getattr(symbol_info, "currency_margin", None),
        "sessionDeals": getattr(symbol_info, "session_deals", None),
        "sessionBuyOrders": getattr(symbol_info, "session_buy_orders", None),
        "sessionSellOrders": getattr(symbol_info, "session_sell_orders", None),
        "tick": serialize_tick(tick),
    }


def serialize_order_request(request):
    if request is None:
        return None

    if hasattr(request, "_asdict"):
        return request._asdict()
    if isinstance(request, dict):
        return request
    return str(request)


def ensure_symbol_ready(symbol):
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        return None, None, error_response(f"Symbol {symbol} not found")
    if not symbol_info.visible and not mt5.symbol_select(symbol, True):
        return None, None, error_response(f"Failed to select symbol {symbol}")

    symbol_info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return None, None, error_response(f"Failed to get price for {symbol}: {mt5.last_error()}")

    return symbol_info, tick, None


def is_tick_stale(tick):
    tick_age = get_tick_age_seconds(tick)
    return (
        STALE_TICK_THRESHOLD_SECONDS > 0
        and tick_age is not None
        and tick_age > STALE_TICK_THRESHOLD_SECONDS
    )


def build_market_closed_result(symbol_info, tick, request=None, message="Market closed"):
    return {
        "allowed": False,
        "retcode": getattr(mt5, "TRADE_RETCODE_MARKET_CLOSED", 10018),
        "retcodeName": "MARKET_CLOSED",
        "comment": message,
        "symbolInfo": serialize_symbol_info(symbol_info, tick),
        "request": serialize_order_request(request),
    }


def build_market_closed_error(symbol_info, tick, request=None, message="Market closed"):
    return error_response(
        message,
        code=getattr(mt5, "TRADE_RETCODE_MARKET_CLOSED", 10018),
        details={
            "reason": "stale_tick",
            "tickAgeSeconds": get_tick_age_seconds(tick),
            "symbolInfo": serialize_symbol_info(symbol_info, tick),
            "request": serialize_order_request(request),
        },
    )


def normalize_stops(symbol_info, order_type, price, sl, tp):
    digits = symbol_info.digits
    point = symbol_info.point
    spread = symbol_info.spread * point
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

    return sl, tp


def build_market_order_request(symbol, order_type, volume, sl=0.0, tp=0.0, comment="", position_id=None):
    symbol_info, tick, error = ensure_symbol_ready(symbol)
    if error:
        return None, None, None, error

    if order_type == "BUY":
        mt5_type = mt5.ORDER_TYPE_BUY
        price = tick.ask
    else:
        mt5_type = mt5.ORDER_TYPE_SELL
        price = tick.bid

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": mt5_type,
        "price": price,
        "deviation": 20,
        "magic": 202400,
        "comment": comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": get_filling_mode(symbol),
    }

    if position_id is not None:
        request["position"] = int(position_id)
    else:
        normalized_sl, normalized_tp = normalize_stops(symbol_info, order_type, price, sl, tp)
        request["sl"] = normalized_sl
        request["tp"] = normalized_tp

    return request, symbol_info, tick, None


def is_check_retcode_ok(retcode):
    """True when MqlTradeCheckResult.retcode means 'can send'."""
    if retcode is None:
        return False

    ok_codes = {
        0,
        getattr(mt5, "TRADE_RETCODE_DONE", 10009),
        getattr(mt5, "TRADE_RETCODE_PLACED", 10008),
    }
    return retcode in ok_codes


def serialize_trade_check(check_result, symbol_info=None, tick=None):
    retcode = getattr(check_result, "retcode", None)

    return {
        "allowed": is_check_retcode_ok(retcode),
        "retcode": retcode,
        "retcodeName": TRADE_RETCODE_NAMES.get(retcode, str(retcode) if retcode is not None else None),
        "comment": getattr(check_result, "comment", None),
        "balance": getattr(check_result, "balance", None),
        "equity": getattr(check_result, "equity", None),
        "profit": getattr(check_result, "profit", None),
        "margin": getattr(check_result, "margin", None),
        "freeMargin": getattr(check_result, "margin_free", None),
        "marginLevel": getattr(check_result, "margin_level", None),
        "symbolInfo": serialize_symbol_info(symbol_info, tick),
        "request": serialize_order_request(getattr(check_result, "request", None)),
    }


def get_order_deals(order_ticket):
    deals = mt5.history_deals_get(ticket=int(order_ticket))
    return sort_deals(deals)


def get_position_deals(position_id):
    deals = mt5.history_deals_get(position=int(position_id))
    return sort_deals(deals)


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

    trade_mode_name = ACCOUNT_TRADE_MODE_NAMES.get(info.trade_mode, str(info.trade_mode))

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
        "tradeMode": info.trade_mode,
        "tradeModeName": trade_mode_name,
        "isDemo": trade_mode_name == "DEMO",
        "isContest": trade_mode_name == "CONTEST",
        "isReal": trade_mode_name == "REAL",
        "company": getattr(info, "company", None),
        "tradeExpert": getattr(info, "trade_expert", None),
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


def handle_preflight_order(params):
    """Validate whether a market order is currently tradable without sending it"""
    symbol = params["symbol"]
    order_type = params["type"]
    volume = float(params["volume"])
    sl = float(params.get("sl", 0))
    tp = float(params.get("tp", 0))
    comment = params.get("comment", "")

    request, symbol_info, tick, error = build_market_order_request(
        symbol, order_type, volume, sl, tp, comment
    )
    if error:
        return error

    if is_tick_stale(tick):
        return {"success": True, "result": build_market_closed_result(symbol_info, tick, request)}

    check = mt5.order_check(request)
    if check is None:
        last_error = mt5.last_error()
        return error_response(
            f"Order preflight failed: {last_error}",
            code=last_error[0] if isinstance(last_error, tuple) and len(last_error) > 0 else None,
            details={
                "symbolInfo": serialize_symbol_info(symbol_info, tick),
                "request": serialize_order_request(request),
                "lastError": last_error,
            },
        )

    check_result = serialize_trade_check(check, symbol_info, tick)
    trade_mode_name = check_result["symbolInfo"]["tradeModeName"] if check_result["symbolInfo"] else "UNKNOWN"
    if trade_mode_name == "DISABLED":
        check_result["allowed"] = False
        check_result["comment"] = "Symbol trading is disabled"
    elif trade_mode_name == "CLOSEONLY":
        check_result["allowed"] = False
        check_result["comment"] = "Symbol is close-only"
    elif trade_mode_name == "LONGONLY" and order_type == "SELL":
        check_result["allowed"] = False
        check_result["comment"] = "Symbol is long-only"
    elif trade_mode_name == "SHORTONLY" and order_type == "BUY":
        check_result["allowed"] = False
        check_result["comment"] = "Symbol is short-only"

    # With `allowed` fixed, retcode=0 only falls through here when the tick is actually stale.
    if not check_result["allowed"] and check_result["retcode"] in (None, 0) and is_tick_stale(tick):
        check_result = build_market_closed_result(symbol_info, tick, request)

    return {"success": True, "result": check_result}


def handle_place_order(params):
    """Place a market order"""
    symbol = params["symbol"]
    order_type = params["type"]  # "BUY" or "SELL"
    volume = float(params["volume"])
    sl = float(params.get("sl", 0))
    tp = float(params.get("tp", 0))
    comment = params.get("comment", "")
    request, symbol_info, tick, error = build_market_order_request(
        symbol, order_type, volume, sl, tp, comment
    )
    if error:
        return error
    if is_tick_stale(tick):
        return build_market_closed_error(symbol_info, tick, request)

    result = mt5.order_send(request)
    if result is None:
        last_error = mt5.last_error()
        return error_response(
            f"Order send failed: {last_error}",
            code=last_error[0] if isinstance(last_error, tuple) and len(last_error) > 0 else None,
            details={
                "symbol": symbol,
                "symbolInfo": serialize_symbol_info(symbol_info, tick),
                "request": serialize_order_request(request),
                "lastError": last_error,
            },
        )
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return error_response(
            f"Order failed: retcode={result.retcode}, comment={result.comment}",
            code=result.retcode,
            details={
                "comment": result.comment,
                "symbol": symbol,
                "symbolInfo": serialize_symbol_info(symbol_info, tick),
                "request": serialize_order_request(request),
            },
        )

    order_deals = get_order_deals(result.order)
    executed_deal = order_deals[-1] if order_deals else None
    position_id = getattr(executed_deal, "position_id", None) or result.order

    return {"success": True, "result": {
        "positionId": str(position_id),
        "orderId": str(result.order),
        "dealId": str(result.deal),
        "volume": result.volume,
        "price": result.price,
        "entryDeal": serialize_deal(executed_deal),
    }}


def execute_position_close(position_id, volume=None, comment="close", reject_full_close=False):
    # Find the position
    positions = mt5.positions_get(ticket=position_id)
    if positions is None or len(positions) == 0:
        return {"success": False, "error": f"Position {position_id} not found"}

    position = positions[0]
    symbol = position.symbol
    current_volume = float(position.volume)
    close_volume = current_volume if volume is None else float(volume)

    if close_volume <= 0:
        return {"success": False, "error": "Close volume must be positive"}
    if reject_full_close and close_volume >= current_volume:
        return {"success": False, "error": f"Partial close volume must be less than open volume {current_volume}"}
    if close_volume > current_volume:
        return {"success": False, "error": f"Close volume {close_volume} exceeds open volume {current_volume}"}

    close_type = "SELL" if position.type == mt5.ORDER_TYPE_BUY else "BUY"
    request, symbol_info, tick, error = build_market_order_request(
        symbol, close_type, close_volume, 0, 0, comment, position_id=position_id
    )
    if error:
        return error
    if is_tick_stale(tick):
        return build_market_closed_error(symbol_info, tick, request)

    result = mt5.order_send(request)
    if result is None:
        last_error = mt5.last_error()
        return error_response(
            f"Close failed: {last_error}",
            code=last_error[0] if isinstance(last_error, tuple) and len(last_error) > 0 else None,
            details={
                "symbol": symbol,
                "symbolInfo": serialize_symbol_info(symbol_info, tick),
                "request": serialize_order_request(request),
                "lastError": last_error,
            },
        )
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return error_response(
            f"Close failed: retcode={result.retcode}, comment={result.comment}",
            code=result.retcode,
            details={
                "comment": result.comment,
                "symbol": symbol,
                "symbolInfo": serialize_symbol_info(symbol_info, tick),
                "request": serialize_order_request(request),
            },
        )

    order_deals = get_order_deals(result.order)
    close_deal = None
    for deal in reversed(order_deals):
        if str(getattr(deal, "position_id", "")) == str(position_id):
            close_deal = deal
            break
    if close_deal is None and order_deals:
        close_deal = order_deals[-1]

    return {"success": True, "result": {
        "positionId": str(position_id),
        "orderId": str(result.order),
        "dealId": str(result.deal),
        "volume": result.volume,
        "price": result.price,
        "closeDeal": serialize_deal(close_deal),
    }}


def handle_close_position(params):
    """Close an open position"""
    position_id = int(params["positionId"])
    return execute_position_close(position_id)


def handle_partial_close_position(params):
    """Partially close an open position"""
    position_id = int(params["positionId"])
    volume = float(params["volume"])
    return execute_position_close(position_id, volume=volume, comment="partial_close", reject_full_close=True)


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
    end_time = params.get("endTime")

    tf = TIMEFRAME_MAP.get(timeframe_str)
    if tf is None:
        return {"success": False, "error": f"Unknown timeframe: {timeframe_str}"}

    # Ensure symbol is selected
    symbol_info = mt5.symbol_info(symbol)
    if symbol_info is None:
        return {"success": False, "error": f"Symbol {symbol} not found"}
    if not symbol_info.visible:
        mt5.symbol_select(symbol, True)

    if start_time and end_time:
        try:
            dt_from = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            dt_from = datetime.fromtimestamp(int(start_time) / 1000, tz=timezone.utc)

        try:
            dt_to = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            dt_to = datetime.fromtimestamp(int(end_time) / 1000, tz=timezone.utc)

        if should_chunk_range(timeframe_str, dt_from, dt_to):
            rates, chunk_error = copy_rates_range_chunked(symbol, tf, dt_from, dt_to, timeframe_str)
            if rates is None:
                return {"success": False, "error": f"Failed to get candles for {symbol}: {chunk_error}"}
        else:
            rates = mt5.copy_rates_range(symbol, tf, dt_from, dt_to)
            if rates is None:
                error = mt5.last_error()
                if (
                    error
                    and len(error) > 0
                    and int(error[0]) == -2
                    and timeframe_str in CHUNKED_RANGE_DAYS_BY_TIMEFRAME
                ):
                    rates, chunk_error = copy_rates_range_chunked(symbol, tf, dt_from, dt_to, timeframe_str)
                    if rates is None:
                        return {"success": False, "error": f"Failed to get candles for {symbol}: {chunk_error}"}

        if rates is not None and len(rates) > limit:
            rates = rates[-limit:]
    elif start_time:
        # copy_rates_from returns candles at/before the requested time, so keep this
        # path only for backward-looking fetches used by live analysis.
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


def handle_get_symbol_info(params):
    """Look up a single broker symbol by its name.

    Returns the serialized symbol_info if the broker recognises the name
    (even when not yet visible in Market Watch), otherwise returns a
    null-valued result. Does NOT auto-select the symbol — used by the
    alias resolver to test candidate names cheaply before committing.
    """
    symbol = params["symbol"]
    info = mt5.symbol_info(symbol)
    if info is None:
        return {"success": True, "result": None}

    return {"success": True, "result": serialize_symbol_info(info)}


def handle_calculate_order_profit(params):
    """Estimate P/L for a hypothetical order using MT5's broker-side contract rules."""
    symbol = params["symbol"]
    order_type = str(params["type"]).upper()
    volume = float(params.get("volume", 1.0))
    open_price = float(params["openPrice"])
    close_price = float(params["closePrice"])

    if order_type not in ("BUY", "SELL"):
        return {"success": False, "error": f"Unsupported order type: {order_type}"}

    symbol_info, tick, error = ensure_symbol_ready(symbol)
    if error:
        return error

    mt5_order_type = mt5.ORDER_TYPE_BUY if order_type == "BUY" else mt5.ORDER_TYPE_SELL
    profit = mt5.order_calc_profit(mt5_order_type, symbol, volume, open_price, close_price)
    if profit is None:
        last_error = mt5.last_error()
        return error_response(
            f"order_calc_profit failed: {last_error}",
            code=last_error[0] if isinstance(last_error, tuple) and len(last_error) > 0 else None,
            details={
                "symbol": symbol,
                "type": order_type,
                "volume": volume,
                "openPrice": open_price,
                "closePrice": close_price,
                "symbolInfo": serialize_symbol_info(symbol_info, tick),
                "lastError": last_error,
            },
        )

    return {
        "success": True,
        "result": {
            "symbol": symbol,
            "type": order_type,
            "volume": volume,
            "openPrice": open_price,
            "closePrice": close_price,
            "profit": float(profit),
            "symbolInfo": serialize_symbol_info(symbol_info, tick),
        },
    }


def handle_list_symbols(params):
    """List broker symbols, optionally filtered by group pattern.

    Used by the alias resolver's discovery fallback when explicit
    candidate names do not match. The 'group' param is forwarded to
    mt5.symbols_get(group=...), so standard MT5 wildcard syntax applies
    (e.g. "*BTC*,*ETH*"). Without a group, all broker symbols are
    returned — which can be large; callers should prefer a group.
    """
    group = params.get("group")
    limit = int(params.get("limit", 5000))

    try:
        if group:
            raw = mt5.symbols_get(group=group)
        else:
            raw = mt5.symbols_get()
    except Exception as exc:  # pragma: no cover - defensive
        return {"success": False, "error": f"symbols_get failed: {exc}"}

    if raw is None:
        error = mt5.last_error()
        if error and error[0] != 0:
            return {"success": False, "error": f"symbols_get error: {error}"}
        raw = []

    names = []
    for info in list(raw)[:limit]:
        names.append({
            "symbol": info.name,
            "path": getattr(info, "path", None),
            "tradeMode": info.trade_mode,
            "tradeModeName": SYMBOL_TRADE_MODE_NAMES.get(info.trade_mode, str(info.trade_mode)),
            "visible": info.visible,
            "digits": info.digits,
        })

    return {"success": True, "result": names}


def handle_get_deals(params):
    """Get deal history"""
    start_time = params.get("startTime")
    end_time = params.get("endTime")
    ticket = params.get("ticket")
    position_id = params.get("positionId")

    dt_from = parse_datetime(start_time, datetime(2020, 1, 1, tzinfo=timezone.utc))
    dt_to = parse_datetime(end_time, datetime.now(timezone.utc))

    if ticket:
        deals = get_order_deals(ticket)
    elif position_id:
        deals = get_position_deals(position_id)
    else:
        deals = mt5.history_deals_get(dt_from, dt_to)

    if deals is None:
        error = mt5.last_error()
        if error[0] != 0:
            return {"success": False, "error": f"Failed to get deals: {error}"}
        return {"success": True, "result": []}

    result = []
    for d in sort_deals(deals):
        deal_time = datetime.fromtimestamp(d.time, tz=timezone.utc)
        if deal_time < dt_from or deal_time > dt_to:
            continue
        result.append(serialize_deal(d))

    return {"success": True, "result": result}


# Command dispatcher
HANDLERS = {
    "connect": handle_connect,
    "disconnect": handle_disconnect,
    "getAccountInfo": handle_get_account_info,
    "getPositions": handle_get_positions,
    "getOrders": handle_get_orders,
    "preflightOrder": handle_preflight_order,
    "placeOrder": handle_place_order,
    "closePosition": handle_close_position,
    "partialClosePosition": handle_partial_close_position,
    "modifyPosition": handle_modify_position,
    "getCandles": handle_get_candles,
    "getPrice": handle_get_price,
    "getDeals": handle_get_deals,
    "getSymbolInfo": handle_get_symbol_info,
    "calculateOrderProfit": handle_calculate_order_profit,
    "listSymbols": handle_list_symbols,
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
