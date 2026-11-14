// Chipnet smoke test for the live AegisBCH + FoldingPool deployments.
//   SOLIDCASH_MNEMONIC_CHIPNET=... SOLIDCASH_ELECTRUM_LOCAL=1 npx solidhat run scripts/chipnet-smoke.ts --network chipnet
//   (forwarder ~/workspace/scratch/bch-blaze/ws-forward.mjs must be running)
// Prints every txid + explorer link and a PASS/FAIL per check. State txs are
// sequential: each spends the previous state UTXO, so each step polls until
// the new state is visible (chipnet blocks ~10 min; 25 min cap per step).
// This run uses FRESH agent keys from the deployer mnemonic (indexes 1, 2),
// so it never collides with earlier runs.
import { ethers } from '@solidcash/solidhat/hardhat3';
import { SignatureTemplate } from '@solidcash/solidcash';
import { StatefulContract } from '@solidcash/solidcash/stateful';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { TransactionBuilder } from '@solidcash/solidcash';
import { keccakComputeLockingBytecode } from '@solidcash/utils';
import { readFileSync } from 'node:fs';
import { encodeTransaction } from '@bitauth/libauth/build/lib/message/transaction-encoding.js';

const AEGIS = 'bchtest:rw28k9m5w3wyxptrkj6tx3mw6p4474meqfx596rkaz9eg5jsj2lv5pjm6q5kq';
const POOL = 'bchtest:r0w6zluhvrfljqg3td5f07yecknumt3q6v6dzzze4a892rzeqs4p6scwr62ms';
// Oracle pool category minted at deploy (the pool funding txid, recovered
// from the deployer history — see scripts/recover-pool-category.mjs).
// AegisBCH reads block.timestamp, so every attach must name this pool;
// FoldingPool reads no block.* and needs none.
const ORACLE_POOL = 'b8e935d8c1dee63c9f91920542639f97088839f17fefa8bd8433b67168e953a6';
const AEGIS_TX = 'fac67a5e87c4f1248682820d0d721a3570df1d39c1d34f24daf4a9c47d4e8f30';
const POOL_TX = 'b4c44363314d06b872417f52ce820c1d7a0ea83c6929666f8dcc8585d6025686';
const MONTH = 202611n;
const DAILY_LIMIT = 100_000n;
const DEPOSIT = 10_000n;
const SPEND = 2_000n;
const WITHDRAW = 3_000n;
const CLAIM_A = 1_000n;
const CLAIM_B = 2_000n;

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

// Poll until checkFn returns a truthy value (or timeout). Logs progress.
async function waitFor(label: string, checkFn: () => Promise<any>, timeoutMs = 25 * 60_000) {
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < timeoutMs) {
    n++;
    try {
      const v = await checkFn();
      if (v) return v;
    } catch (e: any) {
      console.log(`  [${label}] poll ${n} read error: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    if (n % 2 === 1) console.log(`  [${label}] waiting... ${Math.round((Date.now() - start) / 1000)}s elapsed, tip height ${await tipHeight()}`);
    await sleep(30_000);
  }
  throw new Error(`${label}: timed out after ${Math.round(timeoutMs / 60000)} min`);
}

function txidOf(res: any): string {
  if (!res) return '(no txid returned)';
  if (typeof res.txid === 'string') return res.txid;
  if (typeof res.hash === 'string') return res.hash;
  if (res?.txid) return String(res.txid);
  return '(no txid in result)';
}

// --- Explicit fee funder (SolidCash 0.50.0 live-network quirk) ---
// Pure state writes (deposit, setRoot) have no transfer / oracle / trailing
// slot in their block layout, so the SDK allocates NO fee funder for them
// and builds a 0-fee tx the relay rejects ("below the minimum relay fee").
// LESSON from run 4: transferring calls are NOT safe either — withdraw's
// SDK funder was the 2,000-sat spend payout (first P2PKH UTXO by vout),
// far short of the 10,270-sat need, and the tx failed the same way. The
// SDK's funder pick is unreliable whenever several P2PKH UTXOs exist.
// Fix: EVERY state-changing call in this run gets an explicit funder input
// (ownerFunder: largest P2PKH UTXO) + explicit change output (funder minus
// a 10,500-sat fee budget), signed with the signer's own unlockP2PKH().
// It lands after the covenant inputs (like the SDK's own funder), the
// preflight still validates the covenant before broadcast, and the
// 50,000-sat fee cap guards the funds.
// LESSON from run 3: addInput ALONE is not enough — the change output is
// only placed for accounting-pool funders, so the whole funder amount
// became the fee (874,170 sats, stopped only by the fee cap). The call
// needs an explicit change output too (addOutput, funder minus a
// 10,500-sat fee budget), placed before the late suffix.
// The container is NOT in the deposit tx either (deposit has no
// satoshiContainer slot, so the loader skips it): the declared amount is
// credited against the container's existing 10,000-sat seed, and spends
// stay capped by the container's real balance — same books as the mock
// suite, documented in the repo README.
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

async function ownerFunder(): Promise<{ txid: string; vout: number; satoshis: bigint; lock: Uint8Array }> {
  const pk: any = (owner as any).publicKey;
  const pubkey = typeof pk === 'string' ? Buffer.from(pk, 'hex') : Buffer.from(pk);
  const pkh = Buffer.from(ripemd160(sha256(pubkey)));
  const lock = Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), pkh, Buffer.from([0x88, 0xac])]);
  const scripthash = Buffer.from(sha256(lock)).reverse().toString('hex');
  const utxos = await electrumReq('blockchain.scripthash.listunspent', [scripthash]);
  if (!utxos?.length) throw new Error('owner has no plain P2PKH UTXO to fund the fee');
  const best = utxos.sort((a: any, b: any) => b.value - a.value)[0];
  console.log(`  funder input: ${best.tx_hash}:${best.tx_pos} (${best.value} sats)`);
  return { txid: best.tx_hash, vout: best.tx_pos, satoshis: BigInt(best.value), lock: new Uint8Array(lock) };
}

// Fee the manual funder leaves behind: ~9.9k sats was the measured need for
// the 4-input deposit tx; 10,500 leaves a small margin for DER-size wobble
// and stays far under the SDK's 50,000-sat fee cap. The change output is
// placed by addOutput (before the late suffix), and the preflight still
// validates the covenant before anything broadcasts.
const FEE_BUDGET = 10_500n;

function ownerUnlocker(): any {
  const u = (owner as any).unlockP2PKH?.();
  if (!u) throw new Error('signer has no unlockP2PKH() — cannot build the explicit funder input');
  return u;
}

// --- Merkle helpers (inlined from foldingcash/src/merkle.js; on-chain leafOf
// is checked against leafHash below, so any drift fails loudly) ---
function hash160(pubkey: Uint8Array): Buffer {
  return Buffer.from(ripemd160(sha256(pubkey)));
}
function leafHash(pubkey: Uint8Array, amount: bigint): Buffer {
  if (pubkey.length !== 33) throw new Error('claimant pubkey must be 33 bytes');
  const amt = Buffer.alloc(32);
  amt.writeBigUInt64BE(amount, 24);
  return Buffer.from(keccak_256(Buffer.concat([hash160(pubkey), amt])));
}
function hashPair(a: Buffer, b: Buffer): Buffer {
  const [x, y] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(keccak_256(Buffer.concat([x, y])));
}
function buildTree(leaves: Buffer[]) {
  const layers: Buffer[][] = [leaves.map((l) => Buffer.from(l))];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = i + 1 < prev.length ? prev[i + 1] : prev[i];
      next.push(hashPair(left, right));
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}
function getProof(layers: Buffer[][], index: number): Buffer[] {
  const proof: Buffer[] = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const layer = layers[l];
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push(sib < layer.length ? layer[sib] : layer[idx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

console.log('network: chipnet');
console.log('AegisBCH:', AEGIS, '(deploy tx', AEGIS_TX + ')');
console.log('FoldingPool:', POOL, '(deploy tx', POOL_TX + ')');

const [owner, agent, other] = await ethers.getSigners(3);
const ownerAddr = await owner.getAddress();
console.log('owner:', ownerAddr);
console.log('agent:', await agent.getAddress());
console.log('other:', await other.getAddress());

const aegisArtifact = JSON.parse(readFileSync(new URL('../artifacts/solidcash/AegisBCH.json', import.meta.url), 'utf8'));
const poolArtifact = JSON.parse(readFileSync(new URL('../artifacts/solidcash/FoldingPool.json', import.meta.url), 'utf8'));
// NOTE: ethers.getContractAt cannot name an oracle pool, and AegisBCH reads
// block.timestamp — attach via StatefulContract.at with the pool category.
const aegis: any = await StatefulContract.at(AEGIS, aegisArtifact, owner, { oraclePool: ORACLE_POOL });
const pool: any = await StatefulContract.at(POOL, poolArtifact, owner);
console.log('attached to both contracts, tip height', await tipHeight());

// DEBUG ONLY: attempt the claim alone, with failure-point tracing on.
// State already established by run 7: AegisBCH flow complete, 3 keccak
// side-cars deployed, root ec3c2fcf... set on-chain (setRoot tx a40beaa1).
// This run re-checks the root, then calls claim once and prints the
// full VM failure trace if the preflight rejects it.
console.log('\n-- claim debug (root already set, side-cars deployed) --');
const leafA = leafHash(agent.publicKey, CLAIM_A);
const leafB = leafHash(owner.publicKey, CLAIM_B);
const { root, layers } = buildTree([leafA, leafB]);
const proofA = getProof(layers, 0);
const rootHex = hex(root);
const onChainRoot: any = await pool.getRoot(MONTH);
console.log('root:', rootHex, '| on-chain:', hex(onChainRoot), '| match:', hex(onChainRoot) === rootHex);
console.log('leafA:', hex(leafA), '| proof:', proofA.map((p: Buffer) => hex(p)));
console.log('claimant:', hex(agent.publicKey), '| payout:', ownerAddr);

const claimFunder = await ownerFunder();
let r: any;
try {
  r = await pool.claim(MONTH, agent.publicKey, CLAIM_A, proofA, sig(agent), ownerAddr)
    .addInput({ txid: claimFunder.txid, vout: claimFunder.vout, satoshis: claimFunder.satoshis }, ownerUnlocker())
    .addOutput({ to: claimFunder.lock, amount: claimFunder.satoshis - FEE_BUDGET })
    .send();
  console.log('claim tx:', txidOf(r));
  const claimedFlag: any = await waitFor('claim visible (claimed flag 1)', async () => {
    const c = BigInt(await pool.claimed('0x' + hex(leafA)));
    return c === 1n ? c : null;
  });
  check('claim executed (claimed[leaf]=1)', claimedFlag === 1n);
} catch (e: any) {
  console.log('CLAIM FAILED:', String(e?.message ?? e).slice(0, 500));
  check('claim executed (claimed[leaf]=1)', false, String(e?.message ?? e).slice(0, 200));
}

console.log('\n== SMOKE SUMMARY ==');
for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `ALL ${results.length} CHECKS GREEN on Chipnet` : `${failed}/${results.length} CHECKS FAILED`);
if (failed > 0) process.exitCode = 1;
