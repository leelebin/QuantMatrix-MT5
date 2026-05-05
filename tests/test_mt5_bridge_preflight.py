import importlib
import sys
import types
import unittest
from datetime import timezone
from types import SimpleNamespace
from unittest.mock import patch


class SerializeTradeCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mt5_stub = types.SimpleNamespace(
            TRADE_RETCODE_REQUOTE=10004,
            TRADE_RETCODE_REJECT=10006,
            TRADE_RETCODE_PLACED=10008,
            TRADE_RETCODE_DONE=10009,
            TRADE_RETCODE_MARKET_CLOSED=10018,
            TRADE_ACTION_DEAL=1,
            ACCOUNT_TRADE_MODE_DEMO=0,
            ACCOUNT_TRADE_MODE_CONTEST=1,
            ACCOUNT_TRADE_MODE_REAL=2,
            SYMBOL_TRADE_MODE_DISABLED=0,
            SYMBOL_TRADE_MODE_LONGONLY=1,
            SYMBOL_TRADE_MODE_SHORTONLY=2,
            SYMBOL_TRADE_MODE_CLOSEONLY=3,
            SYMBOL_TRADE_MODE_FULL=4,
            DEAL_ENTRY_IN=0,
            DEAL_ENTRY_OUT=1,
            DEAL_ENTRY_INOUT=2,
            DEAL_ENTRY_OUT_BY=3,
            DEAL_REASON_CLIENT=0,
            DEAL_REASON_MOBILE=1,
            DEAL_REASON_WEB=2,
            DEAL_REASON_EXPERT=3,
            DEAL_REASON_SL=4,
            DEAL_REASON_TP=5,
            DEAL_REASON_SO=6,
            DEAL_REASON_ROLLOVER=7,
            DEAL_REASON_VMARGIN=8,
            DEAL_REASON_SPLIT=9,
            ORDER_TYPE_BUY=0,
            ORDER_TYPE_SELL=1,
            ORDER_TYPE_BUY_LIMIT=2,
            ORDER_TYPE_SELL_LIMIT=3,
            ORDER_TYPE_BUY_STOP=4,
            ORDER_TYPE_SELL_STOP=5,
            ORDER_TYPE_BUY_STOP_LIMIT=6,
            ORDER_TYPE_SELL_STOP_LIMIT=7,
            ORDER_TIME_GTC=0,
            TIMEFRAME_M1=1,
            TIMEFRAME_M5=5,
            TIMEFRAME_M15=15,
            TIMEFRAME_M30=30,
            TIMEFRAME_H1=60,
            TIMEFRAME_H2=120,
            TIMEFRAME_H4=240,
            TIMEFRAME_H6=360,
            TIMEFRAME_H8=480,
            TIMEFRAME_H12=720,
            TIMEFRAME_D1=1440,
            TIMEFRAME_W1=10080,
            TIMEFRAME_MN1=43200,
        )
        cls.mt5_patch = patch.dict(sys.modules, {"MetaTrader5": cls.mt5_stub})
        cls.mt5_patch.start()
        cls.mt5_bridge = importlib.import_module("mt5_bridge")

    @classmethod
    def tearDownClass(cls):
        cls.mt5_patch.stop()
        sys.modules.pop("mt5_bridge", None)

    def test_serialize_trade_check_allows_preflight_success_retcodes(self):
        for retcode in (0, 10008, 10009):
            with self.subTest(retcode=retcode):
                check = SimpleNamespace(retcode=retcode, comment="Done")
                result = self.mt5_bridge.serialize_trade_check(check)
                self.assertTrue(result["allowed"])
                self.assertEqual(result["retcode"], retcode)

    def test_handle_connect_explicitly_logs_in_and_verifies_account(self):
        account = SimpleNamespace(login=44938841, server="Elev8-Real2")

        with patch.object(self.mt5_bridge.mt5, "initialize", return_value=True, create=True) as initialize, \
             patch.object(self.mt5_bridge.mt5, "login", return_value=True, create=True) as login, \
             patch.object(self.mt5_bridge.mt5, "account_info", return_value=account, create=True):
            result = self.mt5_bridge.handle_connect({
                "login": "44938841",
                "password": "secret",
                "server": "Elev8-Real2",
                "path": "C:/MT5-Live/terminal64.exe",
            })

        self.assertTrue(result["success"])
        initialize.assert_called_once_with(
            login=44938841,
            password="secret",
            server="Elev8-Real2",
            path="C:/MT5-Live/terminal64.exe",
        )
        login.assert_called_once_with(login=44938841, password="secret", server="Elev8-Real2")

    def test_handle_connect_leaves_account_mismatch_policy_to_service(self):
        account = SimpleNamespace(login=230044684, server="Elev8-Demo2")

        with patch.object(self.mt5_bridge.mt5, "initialize", return_value=True, create=True), \
             patch.object(self.mt5_bridge.mt5, "login", return_value=True, create=True), \
             patch.object(self.mt5_bridge.mt5, "account_info", return_value=account, create=True), \
             patch.object(self.mt5_bridge.mt5, "shutdown", return_value=True, create=True) as shutdown:
            result = self.mt5_bridge.handle_connect({
                "login": "44938841",
                "password": "secret",
                "server": "Elev8-Real2",
            })

        self.assertTrue(result["success"])
        shutdown.assert_not_called()

    def test_serialize_trade_check_rejects_blocking_retcodes(self):
        cases = (
            (10004, "REQUOTE"),
            (10006, "REJECT"),
            (10018, "MARKET_CLOSED"),
        )

        for retcode, retcode_name in cases:
            with self.subTest(retcode=retcode):
                check = SimpleNamespace(retcode=retcode, comment=retcode_name.title())
                result = self.mt5_bridge.serialize_trade_check(check)
                self.assertFalse(result["allowed"])
                self.assertEqual(result["retcodeName"], retcode_name)

    def test_serialize_trade_check_does_not_allow_unknown_retcode(self):
        result = self.mt5_bridge.serialize_trade_check(SimpleNamespace(retcode=None, comment=None))
        self.assertFalse(result["allowed"])
        self.assertIsNone(result["retcode"])

    def test_serialize_symbol_info_includes_contract_fields(self):
        symbol_info = SimpleNamespace(
            name="ETHUSD",
            path="Crypto\\ETHUSD",
            visible=True,
            trade_mode=self.mt5_bridge.mt5.SYMBOL_TRADE_MODE_FULL,
            spread=12,
            digits=2,
            point=0.01,
            trade_stops_level=0,
            trade_freeze_level=0,
            volume_min=0.01,
            volume_max=500.0,
            volume_step=0.01,
            trade_tick_size=0.01,
            trade_tick_value=0.1,
            trade_tick_value_profit=0.1,
            trade_tick_value_loss=0.1,
            trade_contract_size=10.0,
            currency_base="ETH",
            currency_profit="USD",
            currency_margin="USD",
        )

        result = self.mt5_bridge.serialize_symbol_info(symbol_info)

        self.assertEqual(result["tradeTickSize"], 0.01)
        self.assertEqual(result["tradeTickValue"], 0.1)
        self.assertEqual(result["tradeContractSize"], 10.0)
        self.assertEqual(result["currencyProfit"], "USD")

    def test_handle_calculate_order_profit_returns_profit(self):
        symbol_info = SimpleNamespace(
            name="ETHUSD",
            visible=True,
            trade_mode=self.mt5_bridge.mt5.SYMBOL_TRADE_MODE_FULL,
            spread=0,
            digits=2,
            point=0.01,
            trade_stops_level=0,
            trade_freeze_level=0,
            volume_min=0.01,
            volume_max=500.0,
            volume_step=0.01,
        )
        tick = SimpleNamespace(time=0, bid=2300.0, ask=2300.1, last=2300.05, time_msc=0)

        with patch.object(self.mt5_bridge, "ensure_symbol_ready", return_value=(symbol_info, tick, None)), \
             patch.object(self.mt5_bridge.mt5, "order_calc_profit", return_value=-131.1, create=True):
            result = self.mt5_bridge.handle_calculate_order_profit({
                "symbol": "ETHUSD",
                "type": "BUY",
                "volume": 1.0,
                "openPrice": 2318.15,
                "closePrice": 2305.04,
            })

        self.assertTrue(result["success"])
        self.assertAlmostEqual(result["result"]["profit"], -131.1)
        self.assertEqual(result["result"]["symbolInfo"]["volumeMin"], 0.01)

    def test_handle_partial_close_position_returns_close_result(self):
        position = SimpleNamespace(symbol="EURUSD", volume=0.5, type=self.mt5_bridge.mt5.ORDER_TYPE_BUY)
        symbol_info = SimpleNamespace(
            name="EURUSD",
            visible=True,
            digits=5,
            point=0.00001,
            spread=12,
            trade_stops_level=0,
            trade_freeze_level=0,
            volume_min=0.01,
            volume_max=100.0,
            volume_step=0.01,
        )
        tick = SimpleNamespace(time=0, bid=1.1000, ask=1.1002, last=1.1001, time_msc=0)
        send_result = SimpleNamespace(retcode=10009, order=5002, deal=9002, volume=0.2, price=1.1050)
        close_deal = SimpleNamespace(
            ticket=9002,
            order=5002,
            position_id=7001,
            symbol="EURUSD",
            type=self.mt5_bridge.mt5.ORDER_TYPE_SELL,
            volume=0.2,
            price=1.1050,
            profit=25.5,
            swap=0.0,
            commission=-0.2,
            fee=0.0,
            comment="partial_close",
            entry=self.mt5_bridge.mt5.DEAL_ENTRY_OUT,
            reason=self.mt5_bridge.mt5.DEAL_REASON_CLIENT,
            time=0,
            time_msc=0,
        )

        with patch.object(self.mt5_bridge.mt5, "positions_get", return_value=[position], create=True), \
             patch.object(self.mt5_bridge, "build_market_order_request", return_value=({"position": 7001, "volume": 0.2}, symbol_info, tick, None)), \
             patch.object(self.mt5_bridge, "is_tick_stale", return_value=False), \
             patch.object(self.mt5_bridge.mt5, "order_send", return_value=send_result, create=True), \
             patch.object(self.mt5_bridge, "get_order_deals", return_value=[close_deal]):
            result = self.mt5_bridge.handle_partial_close_position({
                "positionId": "7001",
                "volume": 0.2,
            })

        self.assertTrue(result["success"])
        self.assertEqual(result["result"]["positionId"], "7001")
        self.assertEqual(result["result"]["orderId"], "5002")
        self.assertAlmostEqual(result["result"]["volume"], 0.2)
        self.assertEqual(result["result"]["closeDeal"]["id"], "9002")

    def test_handle_partial_close_position_rejects_invalid_volume(self):
        position = SimpleNamespace(symbol="EURUSD", volume=0.5, type=self.mt5_bridge.mt5.ORDER_TYPE_BUY)

        with patch.object(self.mt5_bridge.mt5, "positions_get", return_value=[position], create=True):
            zero_volume = self.mt5_bridge.handle_partial_close_position({
                "positionId": "7001",
                "volume": 0,
            })
            full_volume = self.mt5_bridge.handle_partial_close_position({
                "positionId": "7001",
                "volume": 0.5,
            })

        self.assertFalse(zero_volume["success"])
        self.assertIn("positive", zero_volume["error"])
        self.assertFalse(full_volume["success"])
        self.assertIn("less than open volume", full_volume["error"])

    def test_partial_close_handler_is_registered(self):
        self.assertIn("partialClosePosition", self.mt5_bridge.HANDLERS)

    def test_handle_get_candles_chunks_long_one_minute_ranges(self):
        symbol_info = SimpleNamespace(visible=True)
        chunk_windows = []

        def fake_copy_rates_range(symbol, tf, dt_from, dt_to):
            chunk_windows.append((dt_from, dt_to))
            base_ts = int(dt_from.astimezone(timezone.utc).timestamp())
            next_ts = min(base_ts + 60, int(dt_to.astimezone(timezone.utc).timestamp()))
            return [
                (base_ts, 1.0, 1.1, 0.9, 1.05, 100, 12, 100),
                (next_ts, 1.05, 1.15, 1.0, 1.1, 110, 12, 110),
            ]

        with patch.object(self.mt5_bridge.mt5, "symbol_info", return_value=symbol_info, create=True), \
             patch.object(self.mt5_bridge.mt5, "symbol_select", return_value=True, create=True), \
             patch.object(self.mt5_bridge.mt5, "copy_rates_range", side_effect=fake_copy_rates_range, create=True):
            result = self.mt5_bridge.handle_get_candles({
                "symbol": "EURUSD",
                "timeframe": "1m",
                "startTime": "2026-01-01T00:00:00Z",
                "endTime": "2026-04-20T00:00:00Z",
                "limit": 10,
            })

        self.assertTrue(result["success"])
        self.assertGreater(len(chunk_windows), 1)
        self.assertLessEqual(len(result["result"]), 10)
        self.assertGreater(len(result["result"]), 1)
        self.assertEqual(result["result"][-1]["tickVolume"], 110)


if __name__ == "__main__":
    unittest.main()
