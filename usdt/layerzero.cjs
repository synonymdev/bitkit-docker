const assert = require('node:assert/strict');
const { parseAbi, decodeEventLog } = require('viem');
const { rpc } = require('./rpc.cjs');
const { providerMode } = require('./bridge-http.cjs');
const OFT = '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92';
const oftAbi = parseAbi([
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
]);
const statuses = [
  'INFLIGHT',
  'CONFIRMING',
  'DELIVERED',
  'FAILED',
  'BLOCKED',
  'PAYLOAD_STORED',
  'APPLICATION_BURNED',
  'APPLICATION_SKIPPED',
];
class LayerZeroFixture {
  constructor(node) {
    this.node = node;
    this.reset();
  }
  reset() {
    this.mode = 'healthy';
    this.statuses = new Map();
  }
  async messages(hash) {
    assert(/^0x[0-9a-fA-F]{64}$/.test(hash), 'Expected a source transaction hash');
    const receipt = await rpc(this.node, 'eth_getTransactionReceipt', [hash]);
    if (receipt?.status !== '0x1') return [];
    return receipt.logs
      .filter((log) => log.address.toLowerCase() === OFT.toLowerCase())
      .flatMap((log) => {
        let event;
        try {
          event = decodeEventLog({ abi: oftAbi, ...log });
        } catch {
          return [];
        }
        return [
          {
            guid: event.args.guid,
            pathway: { srcEid: 30110, dstEid: event.args.dstEid, sender: { address: OFT } },
            source: { tx: { txHash: receipt.transactionHash } },
            status: { name: this.statuses.get(hash.toLowerCase()) ?? 'INFLIGHT' },
          },
        ];
      });
  }
  async request(method, url) {
    assert.equal(method, 'GET');
    assert(url.pathname.startsWith('/v1/messages/tx/'), 'Unknown LayerZero fixture path');
    return { data: await this.messages(url.pathname.slice('/v1/messages/tx/'.length)) };
  }
  async set(hash, status) {
    assert(statuses.includes(status), 'Unknown LayerZero status');
    assert((await this.messages(hash)).length, 'Source receipt has no successful OFTSent event');
    this.statuses.set(hash.toLowerCase(), status);
    return { data: await this.messages(hash) };
  }
  setMode(mode) {
    this.mode = providerMode(mode);
    return this.mode;
  }
}
module.exports = { LayerZeroFixture, OFT, oftAbi };
