import importlib.util
import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('marketplace_policy', Path(__file__).with_name('marketplace-policy.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class Policy(unittest.TestCase):
    def source(self, fields):
        return 'fn validate_paykit_payment_params(\nparams: &Value,\n) -> Result<(), Error> {\nfor key in object.keys() { if !matches!(key.as_str(), ' + ' | '.join(json.dumps(v) for v in fields) + ') { return Err(error); } }'

    def test_legacy_and_stable_emit_matching_lock_and_invoice_fields(self):
        for fields, expected in [(['recipient_pubky', 'amount', 'asset'], 'legacy'), (['recipient_pubky', 'amount', 'asset', 'payment_in'], 'payment-window-hours')]:
            selected = policy.select(self.source(fields))
            self.assertEqual(selected, expected)
            script = "import {paymentParams,invoiceBody} from './marketplace/driver/payment-policy.mjs'; console.log(JSON.stringify([paymentParams('seller',1500,process.argv[1]),invoiceBody('bundle','resource','reader',process.argv[1])]))"
            lock, invoice = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, selected], cwd=ROOT, text=True))
            self.assertEqual(lock['amount'], '1500')
            self.assertEqual(lock['asset'], 'BTC')
            if expected == 'legacy':
                self.assertNotIn('payment_in', lock);self.assertNotIn('payment_in', invoice)
            else:
                self.assertEqual(lock['payment_in'], 24);self.assertEqual(invoice['payment_in'], 24)

    def test_unknown_schema_stops_before_driver(self):
        for fields in (['recipient_pubky', 'amount'], ['recipient_pubky', 'amount', 'asset', 'unrecognized']):
            with self.assertRaises(ValueError):policy.select(self.source(fields))
        with self.assertRaises(ValueError):policy.select('unrecognized validator')

    def test_driver_build_and_both_wrapper_paths_supply_the_selected_policy(self):
        wrapper=(ROOT/'pubky-marketplace').read_text()
        for name in ['ensure_sources', 'fetch_sources']:
            body=wrapper.split(name+'() {',1)[1].split('\n}',1)[0]
            self.assertIn('select_lock_policy',body)
        self.assertIn('MARKETPLACE_LOCK_POLICY: ${MARKETPLACE_LOCK_POLICY:-legacy}',(ROOT/'docker-compose.yml').read_text())
        self.assertIn('payment-policy.mjs',(ROOT/'marketplace/driver/Dockerfile').read_text())


if __name__ == '__main__':unittest.main()
