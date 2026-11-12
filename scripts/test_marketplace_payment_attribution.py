"""An unpaid native purchase must never inherit an equal-amount baseline payment."""
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
SETUP = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('./marketplace/driver/driver.mjs','utf8');
function part(from,to){const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start);return source.slice(start,end)}
const code=part('const paymentAddress =','async function purchase(args) {')+'\n'+part('async function statusCommand(args) {',"// Staging's chain")+'\n'+part('async function mine(args) {','async function waitFor(args) {');
const nativeId='a'.repeat(64),baselineId='b'.repeat(64);
function fixture({pool=[nativeId],outputs,knownAddress=null,recordedTxid=null,responseId=nativeId,validAddress=true,status='pending'}={}){
 const purchase={bundle_id:'new-purchase',seller_kind:'bitkit',buyer_kind:'external',amount_sats:10000,derived_address:null,state:'created',...(knownAddress?{payout_address:knownAddress}:{}),...(recordedTxid?{txid:recordedTxid}:{})};
 const current={txid:responseId,vout:outputs??[{value:.0001,scriptPubKey:{type:'witness_v0_keyhash',address:'bcrt1-native'}}]};
 const baseline={txid:baselineId,vout:[{value:.0001,scriptPubKey:{type:'witness_v0_keyhash',address:'bcrt1-baseline'}}]};
 let writes=0,mines=0,output,chain=106;const calls=[];
 const sandbox={STAGING:false,PURCHASES_FILE:'in-memory',Math,
  rpc:async(method,args)=>{calls.push([method,args]);
   if(method==='getrawmempool')return pool;
   if(method==='getrawtransaction')return current;
   if(method==='getblockhash')return 'old-block';
   if(method==='getblock')return {tx:[baseline]};
   if(method==='validateaddress')return {isvalid:validAddress,iswitness:true,witness_version:0,witness_program:'0'.repeat(40)};
   throw Error('unexpected RPC '+method);
  },
  chainInfo:async()=>({height:chain}),fail:message=>{throw Error(message)},
  writeJson:async()=>{writes++},findPurchase:async()=>({purchases:[purchase],purchase}),
  paykitStatus:async()=>({status,amount_matched:status==='confirmed',confirmations:status==='confirmed'?1:0}),
  log:()=>{},out:value=>{output=value},flag:(args,key)=>args.includes(key)?args[args.indexOf(key)+1]:undefined,
  mineBlocks:async()=>{mines++;chain++;return ['owned-block']},
 };
 vm.createContext(sandbox);vm.runInContext(code+';globalThis.statusCommand=statusCommand;globalThis.mine=mine;',sandbox);
 return {purchase,calls,sandbox,metrics:()=>({writes,mines,output})};
}
"""


class MarketplacePaymentAttribution(unittest.TestCase):
    def run_node(self, body):
        result = subprocess.run(['node', '--input-type=module', '-e', SETUP + body],
                                cwd=ROOT, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unknown_native_address_never_scans_or_persists_equal_amount_history(self):
        self.run_node(r"""
        for(const pool of [[],[nativeId]]){
          const f=fixture({pool});await f.sandbox.statusCommand(['new-purchase']);
          assert.equal(f.purchase.txid,undefined);assert.equal(f.purchase.payout_address,undefined);
          assert.equal(f.purchase.state,'created');assert.equal(f.metrics().writes,0);
          assert.equal(f.calls.length,0);assert.match(f.metrics().output.payment_binding_required,/native TXID/);
          await assert.rejects(()=>f.sandbox.mine(['--bundle','new-purchase']),/amount-only inference is refused/);
          assert.equal(f.metrics().mines,0);assert.equal(f.metrics().writes,0);
        }
        """)

    def test_observed_native_txid_binds_only_its_output_and_mines_one_block(self):
        self.run_node(r"""
        const f=fixture({status:'confirmed'});
        await f.sandbox.mine(['--bundle','new-purchase','--txid',nativeId]);
        assert.equal(f.purchase.txid,nativeId);assert.equal(f.purchase.payout_address,'bcrt1-native');
        assert.equal(f.purchase.payout_address_source,'observed_txid');assert.equal(f.metrics().mines,1);
        assert.equal(f.metrics().output.txid,nativeId);assert.equal(f.metrics().output.height,107);
        assert.ok(!f.calls.some(([method])=>['getblock','getblockhash'].includes(method)));
        await f.sandbox.statusCommand(['new-purchase']);
        assert.equal(f.purchase.state,'completed');assert.equal(f.metrics().output.txid,nativeId);
        """)

    def test_invalid_ambiguous_conflicting_or_nonmempool_txid_never_mines(self):
        self.run_node(r"""
        for(const options of [
          {pool:[]},{responseId:baselineId},{recordedTxid:baselineId},{knownAddress:'bcrt1-wrong'},
          {outputs:[{value:.0002,scriptPubKey:{type:'witness_v0_keyhash',address:'bcrt1-native'}}]},
          {outputs:[{value:.0001,scriptPubKey:{type:'witness_v0_keyhash',address:'bcrt1-one'}},{value:.0001,scriptPubKey:{type:'witness_v0_keyhash',address:'bcrt1-two'}}]},
          {outputs:[{value:.0001,scriptPubKey:{type:'pubkeyhash',address:'wrong-type'}}]},
          {validAddress:false},
        ]){
          const f=fixture(options);await assert.rejects(()=>f.sandbox.mine(['--bundle','new-purchase','--txid',nativeId]));
          assert.equal(f.metrics().mines,0);assert.equal(f.metrics().writes,0);assert.equal(f.purchase.state,'created');
        }
        const f=fixture();await assert.rejects(()=>f.sandbox.mine(['--bundle','new-purchase','--txid','not-a-txid']),/exact lowercase native transaction id/);
        assert.equal(f.metrics().mines,0);assert.equal(f.metrics().writes,0);
        """)

    def test_known_address_disambiguates_equal_outputs_and_headless_txid_still_works(self):
        self.run_node(r"""
        const f=fixture({knownAddress:'bcrt1-native',outputs:[
          {value:.0001,scriptPubKey:{type:'witness_v0_keyhash',address:'bcrt1-other'}},
          {value:.0001,scriptPubKey:{type:'witness_v0_keyhash',address:'bcrt1-native'}},
        ]});
        await f.sandbox.mine(['--bundle','new-purchase','--txid',nativeId]);
        assert.equal(f.purchase.txid,nativeId);assert.equal(f.purchase.payout_address,'bcrt1-native');assert.equal(f.metrics().mines,1);
        const h=fixture({knownAddress:'bcrt1-native',recordedTxid:nativeId});h.purchase.seller_kind='headless';
        await h.sandbox.mine(['--bundle','new-purchase']);assert.equal(h.metrics().mines,1);assert.equal(h.metrics().output.txid,nativeId);
        """)


if __name__ == '__main__':
    unittest.main()
