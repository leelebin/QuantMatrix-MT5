import importlib
import sys
import types
import unittest
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

    def test_serialize_trade_check_allows_preflight_success_retcodes(self):
        for retcode in (0, 10008, 10009):
            with self.subTest(retcode=retcode):
                check = SimpleNamespace(retcode=retcode, comment="Done")
                result = self.mt5_bridge.serialize_trade_check(check)
                self.assertTrue(result["allowed"])
                self.assertEqual(result["retcode"], retcode)

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


if __name__ == "__main__":
    unittest.main()
