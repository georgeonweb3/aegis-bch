// One-off probe: list the chipnet deployer's tx history via Electrum (through
// the local forwarder on :15004) and print each tx's inputs/outputs incl.
// CashToken categories, to recover the oracle pool category minted at deploy.
import { sha256 } from '/home/hatch/workspace/scratch/bch-blaze/aegis-bch/node_modules/@noble/hashes/sha2.js';
import { ripemd160 } from '/home/hatch/workspace/scratch/bch-blaze/aegis-bch/node_modules/@noble/hashes/legacy.js';

const DEPLOYER_PUBKEY = '023f38bdcad58e739ffd27eddc87687cd4eb9a88e00e382a06730ca8e2866525e6';
const pkh = Buffer.from(ripemd160(sha256(Buffer.from(DEPLOYER_PUBKEY, 'hex'))));
const lock = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), pkh, Buffer.from([0x88, 0xac])]);
const scripthash = Buffer.from(sha256(lock)).reverse().toString('hex');
console.log('deployer lock:', lock.toString('hex'));
console.log('scripthash:', scripthash);

const ws = new WebSocket('ws://127.0.0.1:15004');
let id = 0;
const pending = new Map();
const send = (method, params) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  if (d.error) p.reject(new Error(JSON.stringify(d.error)));
  else p.resolve(d.result);
};
ws.onerror = () => { console.log('WS ERR'); process.exit(1); };
ws.onopen = async () => {
  try {
    const ver = await send('server.version', ['probe', '1.4']);
    console.log('server:', JSON.stringify(ver));
    const hist = await send('blockchain.scripthash.get_history', [scripthash]);
    console.log('history entries:', hist.length);
    for (const h of hist) {
      const tx = await send('blockchain.transaction.get', [h.tx_hash, true]);
      console.log(`\n== ${h.tx_hash} height=${h.height}`);
      console.log('  vin:', (tx.vin || []).map((v) => `${String(v.txid).slice(0, 12)}:${v.vout}`).join(' '));
      for (const [i, o] of (tx.vout || []).entries()) {
        const td = o.tokenData ? ` token cat=${String(o.tokenData.category).slice(0, 16)}... amt=${o.tokenData.amount} nft=${JSON.stringify(o.tokenData.nft || null)}` : '';
        console.log(`  vout ${i}: value=${o.value} script=${String(o.scriptPubKey?.hex || '').slice(0, 60)}${td}`);
      }
    }
    process.exit(0);
  } catch (e) {
    console.log('PROBE FAIL:', e.message);
    process.exit(1);
  }
};
setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
