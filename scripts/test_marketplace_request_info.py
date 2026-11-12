"""Authenticate actual handoff envelopes; reject substitution without leaking keys."""
import base64
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch
from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_encrypt

spec = importlib.util.spec_from_file_location('request_info', Path(__file__).with_name('marketplace-request-info.py'))
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
BUNDLE = 'W34GRHX2NXFWJZHDMYNV8R4RQ8'
REQUEST = '52c7a3a7-210b-45ca-9e98-56ecd3049e4c'
MASTER = bytes(range(32))
SECRET = base64.urlsafe_b64encode(MASTER).decode().rstrip('=')


def intent_fixture(change=None):
    terms = {'amount': '0.00002000', 'asset': 'btc',
             'rates': [], 'payment_reference': 'private-reference',
             'proposal_expires_at': None, 'payment_deadline': None,
             'accepted_endpoint_identifiers': ['btc-regtest-p2wpkh'],
             'payment_endpoints': {'btc-regtest-p2wpkh': '{"value":"bcrt1qtestpayment1234567890"}'},
             'metadata': json.dumps({'bundle_id': BUNDLE, 'private_marker': 'never-export-me'})}
    intent = {'version': 2, 'app_id': 'paykit-server', 'reader_pubky': 'private-reader-marker',
              'operation': {'PaymentRequestProposal': {'terms': terms}}}
    if change: change(intent)
    return intent


def encoded_intent(intent):
    return bytes.fromhex(subprocess.check_output(
        ['node', str(Path(__file__).with_name('testdata') / 'postcard-intent-fixture.mjs')],
        input=json.dumps(intent), text=True))


def fixture(change=None, plaintext=None):
    intent = intent_fixture(change)
    row = {'row_id': 'a51ca4e9-b878-4fdb-9d41-cea21d1ad8ec',
           'creator_hash': 'ab'*32, 'request_id': REQUEST, 'status': 'delivered'}
    # Independent Node HKDF implementation, upstream labels and explicit AAD;
    # do not use the production context/key helpers to create the test envelope.
    key = subprocess.check_output(['node', '-e', "const{hkdfSync}=require('node:crypto');process.stdout.write(Buffer.from(hkdfSync('sha256',Buffer.from([...Array(32).keys()]),Buffer.alloc(0),'paykit-server/aead/v1',32)).toString('hex'))"],text=True)
    parts = [b'paykit-server', bytes([1]), b'outbox-semantic-intent', bytes.fromhex('ab'*32), bytes.fromhex('a51ca4e9b8784fdb9d41cea21d1ad8ec')]
    aad = b''.join(len(p).to_bytes(4,'big')+p for p in parts)
    nonce = bytes(range(24))
    cipher = crypto_aead_xchacha20poly1305_ietf_encrypt(
        encoded_intent(intent) if plaintext is None else plaintext, aad, nonce, bytes.fromhex(key))
    row['envelope'] = (bytes([1])+nonce+cipher).hex()
    return row


class RequestInfo(unittest.TestCase):
    def test_rust_postcard_113_golden_matches_independent_writer_and_authenticated_projection(self):
        directory = Path(__file__).with_name('testdata')
        intent = json.loads((directory / 'request-v2-intent.json').read_text())
        golden = bytes.fromhex((directory / 'request-v2.postcard.hex').read_text())
        self.assertEqual(encoded_intent(intent), golden)
        value = module.project(fixture(plaintext=golden), SECRET, BUNDLE, REQUEST)
        self.assertEqual(value['asset'], 'btc')
        self.assertEqual(value['endpoints'][0]['value'], 'bcrt1qtestpayment1234567890')
        for length in range(len(golden)):
            with self.subTest(truncated=length), self.assertRaises(Exception):
                module.decode_intent(golden[:length])
        rate_index = golden.index(b'\x03btc\x00') + 4
        with self.assertRaises(Exception):
            module.decode_intent(golden[:rate_index] + b'\x01' + golden[rate_index+1:])

    def test_real_postcard_encoding_rejects_the_previous_json_assumption(self):
        raw = encoded_intent(intent_fixture())
        self.assertEqual(module.decode_intent(raw), {
            'version': 2, 'reader_pubky': 'private-reader-marker', 'app_id': 'paykit-server',
            'operation': {'PaymentRequestProposal': {'terms': {
                key: value for key, value in intent_fixture()['operation']['PaymentRequestProposal']['terms'].items()
                if key in ('amount','asset','accepted_endpoint_identifiers','payment_endpoints','metadata')}}}})
        for malformed in (json.dumps(intent_fixture()).encode(), raw[:-1], raw + b'\x00',
                          b'\x82\x00' + raw[1:], raw[:2], b'\x02' + b'\xff'*5):
            with self.subTest(size=len(malformed)), self.assertRaises(Exception):
                module.project(fixture(plaintext=malformed), SECRET, BUNDLE, REQUEST)
        value = module.project(fixture(lambda i:i['operation']['PaymentRequestProposal']['terms'].update(
            proposal_expires_at='2026-10-24T12:00:00Z', payment_deadline='2026-10-24T13:00:00Z')),
            SECRET, BUNDLE, REQUEST)
        self.assertTrue(value['endpoints'][0]['public_bitcoin_json'])

    def test_delivered_request_reports_exact_authenticated_endpoint_and_no_other_data(self):
        value = module.project(fixture(), SECRET, BUNDLE, REQUEST)
        self.assertEqual(value['payment_request_id'], REQUEST)
        self.assertEqual(value['asset'], 'btc')
        self.assertEqual(value['endpoints'][0]['identifier'], 'btc-regtest-p2wpkh')
        self.assertEqual(value['endpoints'][0]['value_json'], '{"value":"bcrt1qtestpayment1234567890"}')
        self.assertTrue(value['endpoints'][0]['public_bitcoin_json'])
        for private in (SECRET, MASTER.hex(), 'never-export-me', 'private-reader-marker', 'creator_hash', 'envelope'):
            self.assertNotIn(private, json.dumps(value))

    def test_context_ciphertext_key_request_and_bundle_substitution_refused(self):
        row = fixture()
        for key,value in [('row_id','b51ca4e9-b878-4fdb-9d41-cea21d1ad8ec'),('creator_hash','bc'*32),('envelope',row['envelope'][:-2]+'00'),('status','handed_off'),('request_id','00000000-0000-0000-0000-000000000000')]:
            changed = dict(row, **{key:value})
            with self.subTest(key=key), self.assertRaises(Exception):module.project(changed, SECRET, BUNDLE, REQUEST)
        with self.assertRaises(Exception):module.project(row, base64.urlsafe_b64encode(bytes(32)).decode().rstrip('='), BUNDLE, REQUEST)
        with self.assertRaises(Exception):module.project(row, SECRET, '0'*26, REQUEST)

    def test_unknown_protocol_refused_but_negative_asset_and_json_observations_retained(self):
        for change in (lambda i:i.update(version=3), lambda i:i.update(app_id='other')):
            with self.assertRaises(Exception):module.project(fixture(change), SECRET, BUNDLE, REQUEST)
        wrong_asset = module.project(fixture(lambda i:i['operation']['PaymentRequestProposal']['terms'].update(asset='BTC')), SECRET, BUNDLE, REQUEST)
        self.assertEqual(wrong_asset['asset'], 'BTC')
        for raw in ('not-json-private-marker', '{"value":"secret-marker"}', '{"value":"bcrt1qtestpayment1234567890","secret":"never-export-me"}'):
            def change(i):i['operation']['PaymentRequestProposal']['terms']['payment_endpoints'].update({'btc-regtest-p2wpkh':raw})
            result=module.project(fixture(change), SECRET, BUNDLE, REQUEST)
            self.assertFalse(result['endpoints'][0]['public_bitcoin_json'])
            self.assertIsNone(result['endpoints'][0]['value_json'])
            for marker in ('private-marker','secret-marker','never-export-me'):
                self.assertNotIn(marker,json.dumps(result))

    def test_observation_queries_only_selected_request_read_only_and_fixed_fixture_key(self):
        calls=[];row=fixture()
        def run(argv,**kwargs):
            calls.append((argv,kwargs))
            return subprocess.CompletedProcess(argv,0,stdout=json.dumps(row)+'\n' if len(calls)==1 else SECRET+'\n')
        self.assertEqual(module.observe(BUNDLE, REQUEST, run)['delivery'],'delivered')
        self.assertEqual(len(calls),2)
        self.assertIn('BEGIN READ ONLY;',calls[0][0][-1]);self.assertIn(REQUEST,calls[0][0][-1])
        self.assertEqual(calls[1][0][-3:],['paykit-server','cat','/state/paykit/master-key'])
        for argv,kw in calls:
            self.assertNotIn(SECRET,str(argv));self.assertTrue(kw['capture_output']);self.assertTrue(kw['check']);self.assertEqual(kw['timeout'],20)
        for bundle,request in [(BUNDLE,"' OR true --"),('../escape',REQUEST)]:
            with self.assertRaises(Exception):module.observe(bundle,request,run)
        self.assertEqual(len(calls),2)

    def test_ambiguous_missing_or_private_errors_never_print_secret_output(self):
        for output in ('', json.dumps(fixture())+'\n'+json.dumps(fixture())):
            with self.assertRaises(Exception):module.observe(BUNDLE,REQUEST,lambda *a,**k:subprocess.CompletedProcess([],0,stdout=output))
        with patch.object(module,'observe',side_effect=RuntimeError(SECRET+' never-export-me')), patch('sys.stderr',new_callable=io.StringIO) as stderr, patch('sys.stdout',new_callable=io.StringIO) as stdout:
            self.assertEqual(module.main([BUNDLE,REQUEST]),1)
            self.assertEqual(stdout.getvalue(),'');self.assertNotIn(SECRET,stderr.getvalue());self.assertNotIn('never-export-me',stderr.getvalue())


if __name__ == '__main__':unittest.main()
