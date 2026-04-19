import importlib
import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class Mt5BridgePreflightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mt5_stub = types.SimpleNamespace(
            TRADE_RETCODE_REQUOTE=10004,
            TRADE_RETCODE_REJECT=10006,
            TRADE_RETCODE_PLACED=10008,
            TRADE_RETCODE_DONE=10009,
            TRADE_RETCODE_MARKET_CLOSED=10018,
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

    def test_is_check_retcode_ok_matches_expected_codes(self):
        self.assertTrue(self.mt5_bridge.is_check_retcode_ok(0))
        self.assertTrue(self.mt5_bridge.is_check_retcode_ok(10008))
        self.assertTrue(self.mt5_bridge.is_check_retcode_ok(10009))
        self.assertFalse(self.mt5_bridge.is_check_retcode_ok(10004))
        self.assertFalse(self.mt5_bridge.is_check_retcode_ok(10018))
        self.assertFalse(self.mt5_bridge.is_check_retcode_ok(None))

    def test_serialize_trade_check_uses_ok_retcode_set(self):
        cases = (
            (0, True),
            (10008, True),
            (10009, True),
            (10004, False),
            (10018, False),
            (None, False),
        )

        for retcode, expected in cases:
            with self.subTest(retcode=retcode):
                result = self.mt5_bridge.serialize_trade_check(
                    SimpleNamespace(retcode=retcode, comment="Done")
                )
                self.assertEqual(result["allowed"], expected)
                self.assertEqual(result["retcode"], retcode)


if __name__ == "__main__":
    unittest.main()
