"""Known SDK signatures choose versioned acceptance; unknown APIs fail closed."""
import subprocess
import tempfile
import unittest
from pathlib import Path

SELECTOR = Path(__file__).resolve().parents[1] / 'payment-requests/select-sdk-features.sh'


class PaykitSDKFeatures(unittest.TestCase):
    def run_selector(self, extra='', return_type='PaymentRequestRecord'):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'payment_requests.rs'
            path.write_text('pub async fn accept_payment_request(\n    &self,\n    counterparty: PubkyPublicKey,\n    payment_request_id: &PaymentRequestId,\n' + extra + ') -> Result<' + return_type + '> {\n    do_not_inspect_body();\n}\n')
            return subprocess.run(['sh',str(SELECTOR),str(path)],text=True,capture_output=True)

    def test_legacy_default_and_versioned_stable_api(self):
        legacy = self.run_selector()
        self.assertEqual(legacy.returncode,0,legacy.stderr)
        self.assertEqual(legacy.stdout,'')
        stable = self.run_selector('    expected_proposal_stream_item_id: u64,\n')
        self.assertEqual(stable.returncode,0,stable.stderr)
        self.assertEqual(stable.stdout.strip(),'--features=versioned-payment-request-acceptance')

    def test_unrecognized_api_and_ambiguous_source_never_guess_a_build_feature(self):
        for arguments in [('    timeout: u64,\n','PaymentRequestRecord'), ('    expected_proposal_stream_item_id: Option<u64>,\n','PaymentRequestRecord'), ('','OtherRecord')]:
            with self.subTest(arguments=arguments):
                result = self.run_selector(*arguments)
                self.assertNotEqual(result.returncode,0)
                self.assertIn('Unsupported Paykit SDK acceptance API',result.stderr)
        result = subprocess.run(['sh',str(SELECTOR),'first.rs','second.rs'],text=True,capture_output=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('exactly one',result.stderr)


if __name__ == '__main__':
    unittest.main()
