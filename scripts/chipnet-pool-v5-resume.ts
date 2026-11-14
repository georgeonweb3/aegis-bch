// FoldingPool V5 resume: the smoke run (chipnet-pool-v5-smoke.ts) got through
// leafOf + verifyProof + setRoot + claim (all broadcast, all visible in the
// SDK's mempool-derived state) but the collect wait timed out after 25 min:
// the collect tx a9f1388f... sat in the mempool while chipnet mined no blocks
// that included it (tip stalled ~332350; the Aegis txs confirmed fine at 8
// confs, so this is chipnet block production, not the tx). This script does
// NOT re-broadcast anything already sent. It:
//   1. waits for the collect tx to CONFIRM (Electrum confirmations >= 1),
//   2. reads claims[leaf]/claimed[leaf] via the contract view and verifies
//      the 1,000-sat payout output in the confirmed tx,
//   3. runs the double-collect + double-claim blocks.
// Run: SOLIDCASH_MNEMONIC_CHIPNET="$(cat .chipnet-mnemonic)" SOLIDCASH_ELECTRUM_LOCAL=1 npx solidhat run scripts/chipnet-pool-v5-resume.ts --network chipnet
import { ethers } from '@solidcash/solidhat/hardhat3';
import { SignatureTemplate } from '@solidcash/solidcash';
import { StatefulContract } from '@solidcash/solidcash/stateful';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { readFileSync } from 'node:fs';

const POOL = 'bchtest:rvpyzut9z2ckw6ryawl6q9hjpsf7jnpf9dwfhmhezwpkdse794cvsyu6rh5sv';
const COLLECT_TX = 'a9f1388f850c83b6674ed2a6d3f79baf79e7fe835b42520bde480f5929290f53';
const CLAIM_TX = '5bac2129571815f0c2cfb407131faa659c16dcb403abef4aed5a9850268a2082';
const CLAIM_A = 1_000n;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hex = (b: any) => Buffer.from(b).toString('hex');
const sig = (s: any) => new SignatureTemplate(s.privateKey);
const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push([name, ok, detail]);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

async function tipHeight(): Promise<number | string> {
  try {
    const r = await fetch('https://chipnet.imaginary.cash/api/blocks?limit=1');
    return (await r.json() as any).blockList[0].height;
  } catch { return '?'; }
}

async function electrumReq(method: string, params: any[]): Promise<any> {
  const ws = new WebSocket('ws://127.0.0.1:15004');
  let id = 0;
  const pending = new Map<number, [(v: any) => void, (e: any) => void]>();
  const req = (m: string, p: any[]) => new Promise<any>((res, rej) => {
    const i = ++id;
    pending.set(i, [res, rej]);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: i, method: m, params: p }));
  });
  ws.onmessage = (e: any) => {
    const d = JSON.parse(e.data);
    if (d.id && pending.has(d.id)) {
      const [res, rej] = pending.get(d.id)!;
      pending.delete(d.id);
      d.error ? rej(new Error(d.error.message)) : res(d.result);
    }
  };
  await new Promise<void>((r) => { ws.onopen = () => r(); });
  try { return await req(method, params); }
  finally { ws.close(); }
}

function hash160(pubkey: Uint8Array): Buffer {
  return Buffer.from(ripemd160(sha256(pubkey)));
}
function leafHash(pubkey: Uint8Array, amount: bigint): Buffer {
  const amt = Buffer.alloc(32);
  amt.writeBigUInt64BE(amount, 24);
  return Buffer.from(sha256(Buffer.concat([hash160(pubkey), amt])));
}

console.log('network: chipnet');
console.log('FoldingPool V5:', POOL);
console.log('waiting for collect tx to confirm:', COLLECT_TX);

const [owner, agent] = await ethers.getSigners(3);
const ownerAddr = await owner.getAddress();
const leafA = leafHash(agent.publicKey, CLAIM_A);
console.log('leafA:', hex(leafA));

// --- 1. Wait for the collect tx to confirm (up to 3h; chipnet is slow) ---
const start = Date.now();
let confirmations = 0;
while (Date.now() - start < 3 * 60 * 60_000) {
  try {
    const tx = await electrumReq('blockchain.transaction.get', [COLLECT_TX, true]);
    confirmations = tx.confirmations ?? 0;
    if (confirmations >= 1) {
      console.log(`collect tx CONFIRMED: ${confirmations} confirmation(s), height=${tx.height}, size=${tx.size}`);
      break;
    }
    console.log(`  collect still in mempool... ${Math.round((Date.now() - start) / 60000)} min elapsed, tip height ${await tipHeight()}`);
  } catch (e: any) {
    console.log('  collect tx lookup error:', String(e?.message ?? e).slice(0, 120));
  }
  await sleep(60_000);
}
check('collect tx confirmed on-chain', confirmations >= 1, `${confirmations} confirmation(s)`);

// --- 2. Verify state + payout from the confirmed tx ---
const poolArtifact = JSON.parse(readFileSync(new URL('../artifacts/solidcash/FoldingPool.json', import.meta.url), 'utf8'));
const pool: any = await StatefulContract.at(POOL, poolArtifact, owner);
console.log('attached to FoldingPool V5, tip height', await tipHeight());

try {
  const claimsAfter: any = await pool.claims('0x' + hex(leafA));
  check('collect paid 1,000 (claims[leaf]=0)', BigInt(claimsAfter) === 0n, `claims[leaf]=${claimsAfter}`);
} catch (e: any) {
  check('collect paid 1,000 (claims[leaf]=0)', false, `view read failed: ${String(e?.message ?? e).slice(0, 150)}`);
}
try {
  const claimedAfter: any = await pool.claimed('0x' + hex(leafA));
  check('claimed[leaf] still 1 after collect', BigInt(claimedAfter) === 1n, `claimed[leaf]=${claimedAfter}`);
} catch (e: any) {
  check('claimed[leaf] still 1 after collect', false, `view read failed: ${String(e?.message ?? e).slice(0, 150)}`);
}
// Payout proof straight from the confirmed tx: a 1,000-sat output to the
// owner's P2PKH lock (the claim's payout address was ownerAddr).
try {
  const tx: any = await electrumReq('blockchain.transaction.get', [COLLECT_TX, true]);
  const pk: any = (owner as any).publicKey;
  const pubkey = typeof pk === 'string' ? Buffer.from(pk, 'hex') : Buffer.from(pk);
  const pkh = Buffer.from(ripemd160(sha256(pubkey)));
  const lockHex = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), pkh, Buffer.from([0x88, 0xac])]).toString('hex');
  const payoutOut = (tx.vout || []).find((o: any) => o.value === 0.00001 && String(o.scriptPubKey?.hex || '') === lockHex);
  check('confirmed collect tx pays 1,000 sats to the claimant payout', !!payoutOut, payoutOut ? `vout value=${payoutOut.value}` : 'no matching 1,000-sat P2PKH output found');
} catch (e: any) {
  check('confirmed collect tx pays 1,000 sats to the claimant payout', false, String(e?.message ?? e).slice(0, 150));
}

// --- 3. Double-collect must fail (amount already zeroed) ---
let doubleCollectBlocked = false;
try {
  const bad: any = await pool.collect('0x' + hex(leafA), sig(agent));
  console.log('double-collect unexpectedly returned:', bad?.txid ?? bad);
} catch (e: any) {
  doubleCollectBlocked = true;
  console.log('double-collect rejected:', String(e?.message ?? e).slice(0, 200));
}
check('double-collect blocked', doubleCollectBlocked);

// --- 4. Double-claim must fail (claimed flag already 1) ---
let doubleBlocked = false;
try {
  const bad: any = await pool.claim(agent.publicKey, '0x' + hex(leafA), CLAIM_A, ownerAddr, sig(owner));
  console.log('double-claim unexpectedly returned:', bad?.txid ?? bad);
} catch (e: any) {
  doubleBlocked = true;
  console.log('double-claim rejected:', String(e?.message ?? e).slice(0, 200));
}
check('double-claim blocked', doubleBlocked);

console.log('\n== V5 RESUME SUMMARY ==');
for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `ALL ${results.length} CHECKS GREEN on Chipnet` : `${failed}/${results.length} CHECKS FAILED`);
if (failed > 0) process.exitCode = 1;
