import json
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class NativeSellerState(unittest.TestCase):
    def run_node(self, script):
        subprocess.run(['node', '--input-type=module', '-e',
            "import assert from 'node:assert/strict'; import {requireFixture,selectSeller,rememberBitkitSeller} from './marketplace/driver/seller-state.mjs';\n" + script],
            cwd=ROOT, check=True, capture_output=True, text=True)

    def test_fresh_native_seller_needs_no_headless_identity_or_spending_keys(self):
        self.run_node("""
        const approved={pubky:'native',kind:'bitkit',client_id:'locks.app',capabilities:'/pub/app.locks/:rw'};
        const state=rememberBitkitSeller({},approved,true,'first');
        assert.equal(requireFixture(state),state);
        assert.equal(requireFixture(state,true),state);
        assert.equal(selectSeller(state,'bitkit').pubky,'native');
        assert.equal(selectSeller(state,'native').setup_completed_at,'first');
        assert.equal(state.seller,undefined);
        assert.throws(()=>selectSeller(state,'headless'),/no headless seller/);
        assert.throws(()=>selectSeller(state,'other'),/--seller must/);
        assert.throws(()=>requireFixture({}),/no seller yet/);
        """)

    def test_same_identity_preserves_setup_but_replacement_cannot_inherit_it(self):
        self.run_node("""
        const first=rememberBitkitSeller({}, {pubky:'a'},true,'first');
        assert.equal(rememberBitkitSeller(first,{pubky:'a'},true,'again').bitkit_seller.setup_completed_at,'first');
        const replaced=rememberBitkitSeller(first,{pubky:'b'},false,'new');
        assert.equal(replaced.bitkit_seller.setup_completed_at,undefined);
        assert.equal(replaced.bitkit_seller.marketplace_grant_at,'new');
        assert.equal(first.bitkit_seller.pubky,'a');
        """)

    def test_headless_flow_remains_explicit_and_native_grant_has_no_seed_precheck(self):
        self.run_node("""
        const headless={seller:{pubky:'headless',kind:'headless'}};
        assert.equal(requireFixture(headless),headless);
        assert.equal(selectSeller(headless,'headless'),headless.seller);
        assert.throws(()=>requireFixture(headless,true),/no Bitkit seller/);
        const withNative=rememberBitkitSeller(headless,{pubky:'native'},true,'now');
        assert.equal(withNative.seller,headless.seller);
        """)
        source=(ROOT/'marketplace/driver/driver.mjs').read_text()
        start=source.split('async function sellerAuth(args) {',1)[1].split('\n}',1)[0]
        self.assertNotIn('readFixture()',start)
        adopt=source.split('async function adoptBitkitSeller(session, kind) {',1)[1].split('\n}',1)[0]
        self.assertIn('await readJson(FIXTURE_FILE, {})',adopt)
        self.assertIn('rememberBitkitSeller',adopt)

    def test_seeding_a_headless_seller_preserves_existing_native_state(self):
        # Execute the actual async seed function; replace only external key,
        # storage and service boundaries with isolated in-memory counterparts.
        self.run_node("""
        const fs=await import('node:fs'); const vm=await import('node:vm');
        const source=fs.readFileSync('./marketplace/driver/driver.mjs','utf8');
        const begin=source.indexOf('async function seed(args) {');
        const end=source.indexOf('const flagPresent =',begin);
        assert.ok(begin>=0 && end>begin);
        const initial={bitkit_seller:{pubky:'native',setup_completed_at:'approved'},buyer:{pubky:'existing-buyer'},other:'preserved'};
        let state=structuredClone(initial);let writes=0;
        const sandbox={
          SERVER_PATH:'bitkit/server',FIXTURE_FILE:'/state/fixture.json',SECRETS:'/state/secrets',HOMESERVER:'testnet',ACCOUNT_INDEX:0,
          flag:(args,name)=>args[args.indexOf(name)+1],flagPresent:(args,name)=>args.includes(name),
          waitForPaykit:async()=>{},ensureMatureCoins:async()=>{},readJson:async()=>structuredClone(state),
          b64url:(bytes)=>bytes.toString('base64url'),randomBytes:()=>Buffer.alloc(32,1),
          HDKey:{fromMasterSeed:()=>({derive:()=>({publicExtendedKey:'tpub-test'})})},
          writeSecret:async()=>{},signUpIdentity:async()=>'headless',log:()=>{},fail:(s)=>{throw Error(s)},
          beginSetup:async()=>({flowId:'test',authUrl:'test-only'}),approveSetupAs:async()=>{},completeSetup:async()=>{},
          writeJson:async(_path,value)=>{state=structuredClone(value);writes++},publicInfo:async()=>state,out:()=>{},
        };
        vm.createContext(sandbox);vm.runInContext(source.slice(begin,end)+';globalThis.seed=seed;',sandbox);
        await sandbox.seed(['--buyer','none']);
        assert.deepEqual(state.bitkit_seller,initial.bitkit_seller);
        assert.deepEqual(state.buyer,initial.buyer);assert.equal(state.other,'preserved');
        assert.equal(state.seller.pubky,'headless');assert.equal(writes,1);
        await sandbox.seed(['--buyer','none']);assert.equal(writes,1);
        """)


if __name__ == '__main__':unittest.main()
