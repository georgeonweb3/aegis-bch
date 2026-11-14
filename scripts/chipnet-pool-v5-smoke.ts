// FoldingPool V5 smoke test (fixed-depth proof, no dynamic loop).
//   SOLIDCASH_MNEMONIC_CHIPNET=... SOLIDCASH_ELECTRUM_LOCAL=1 npx solidhat run scripts/chipnet-pool-v5-smoke.ts --network chipnet
// V1's claim died in the derive at the leaf bind (VM OP_VERIFY ip 133)
// because its dynamic proof loop routes through the SDK's progressive-
// probe loop resolver, whose trailing side-car band collides with the
// leaf's fixed keccak slot. V2's _verify is straight-line: all 3 keccak
// calls sit in one fixed side-car batch. Fill in POOL / POOL_TX /
// POOL_CATEGORY from scripts/deploy-pool-v2.ts output before running.
// The pool is funded 100,000 sats at deploy; the claim below pays the
// agent 1,000 and leaves the owner's 2,000-leaf unclaimed.
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

// >>> FILL IN from deploy-pool-v2.ts output <<<
// >>> FILL IN from deploy-pool-v3.ts output <<<
const POOL = 'bchtest:rvpyzut9z2ckw6ryawl6q9hjpsf7jnpf9dwfhmhezwpkdse794cvsyu6rh5sv';
const POOL_TX = '0ce114e3dfa5bce4b72f0e6dc9f308ff06be2f4747f352fef4f1a918b23ddb4b';
const POOL_CATEGORY = 'f7e372e065c2aba86b6137c4ccd8acca046e916fff2539cf1b7b9b4e75d87e48'; // read off the genesis tx's token outputs (category = funding-split txid, NOT the genesis txid)
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
  return Buffer.from(sha256(Buffer.concat([hash160(pubkey), amt])));
}
function hashPair(a: Buffer, b: Buffer): Buffer {
  const [x, y] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(sha256(Buffer.concat([x, y])));
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
console.log('FoldingPool V5:', POOL, '(deploy tx', POOL_TX + ')');
console.log('FoldingPool V5 category:', POOL_CATEGORY);

const [owner, agent, other] = await ethers.getSigners(3);
const ownerAddr = await owner.getAddress();
console.log('owner:', ownerAddr);
console.log('agent:', await agent.getAddress());
console.log('other:', await other.getAddress());

const poolArtifact = JSON.parse(readFileSync(new URL('../artifacts/solidcash/FoldingPool.json', import.meta.url), 'utf8'));
// FoldingPool reads no block.* — plain attach, no oracle pool.
const pool: any = await StatefulContract.at(POOL, poolArtifact, owner);
console.log('attached to FoldingPool V5, tip height', await tipHeight());

// --- 1. Keccak compute side-cars (live-network requirement) ---
// A keccak256 call in a stateful contract needs a compute side-car UTXO
// (mutable NFT, 2,000 sats, 32-zero-byte commitment) at
// keccakComputeLockingBytecode(reversed pool category). The mock provider
// mints these on demand; a real network holds only what someone deployed.
// V2 claim has 3 fixed keccak calls in ONE side-car batch, so 2 side-cars
// is comfortable. Pattern copied from the SDK's framed deploy helper
// (deployComputeSideCarPool), branded to THIS pool's category.
// GENESIS RULE (CashTokens, proven by run 6): a transaction may mint a
// new category ONLY if the category equals the txid of an input spent at
// vout 0 (libauth extractGenesisCategories). So the deploy is two
// transactions: (A) a self-send that puts the owner's funds at vout 0,
// then (B) the side-car mint spending that vout-0 coin, category = tx A.
const EMPTY_RESULT = '00'.repeat(32);
async function deployKeccakSidecars(count = 3) {
  const salt = Buffer.from(POOL_CATEGORY, 'hex').reverse();
  const lock = keccakComputeLockingBytecode(new Uint8Array(salt), true);
  const provider: any = (ethers as any).provider;
  const listSidecars = async () => {
    const us = await provider.getUtxosForLockingBytecode(lock);
    return us.filter((u: any) => u.token?.nft?.capability === 'mutable');
  };
  const have = (await listSidecars()).length;
  console.log(`  keccak side-cars at branded lock: ${have} (want ${count})`);
  if (have >= count) return;
  // (A) self-send: move the largest P2PKH UTXO to vout 0.
  const coin = await ownerFunder();
  const prep = new TransactionBuilder({ provider });
  prep.addInput({ txid: coin.txid, vout: coin.vout, satoshis: coin.satoshis }, ownerUnlocker());
  prep.addOutput({ to: coin.lock, amount: coin.satoshis - 1_245n });
  const prepSent: any = await prep.send();
  console.log('vout-0 prep tx:', prepSent.txid);
  const prepTxid: string = prepSent.txid;
  const v0 = await waitFor('vout-0 coin visible', async () => {
    const best = await ownerFunder();
    return best.txid === prepTxid && best.vout === 0 ? best : null;
  });
  // (B) mint the side-cars, spending the vout-0 coin; category = prep txid.
  const need = count - have;
  const outputs = Array.from({ length: need }, () => ({
    to: lock,
    amount: 2000n,
    token: { category: prepTxid, amount: 0n, nft: { capability: 'mutable', commitment: EMPTY_RESULT } },
  }));
  const value = BigInt(need) * 2000n;
  const build = (change: bigint) => {
    const b = new TransactionBuilder({ provider });
    b.addInput({ txid: v0.txid, vout: v0.vout, satoshis: v0.satoshis }, ownerUnlocker());
    for (const o of outputs) b.addOutput(o);
    b.addOutput({ to: v0.lock, amount: change });
    return b;
  };
  const size = BigInt(encodeTransaction(build(v0.satoshis - value).buildLibauthTransaction()).byteLength);
  const sent: any = await build(v0.satoshis - value - size).send();
  console.log('side-car deploy tx:', sent.txid, `minted ${need}`);
  await waitFor('side-cars visible', async () => {
    const n = (await listSidecars()).length;
    return n >= count ? n : null;
  });
  console.log(`  side-cars now: ${(await listSidecars()).length}`);
}
// V5 smoke: fresh pool. NO side-cars (V5 claim/collect/setRoot are
// hash-free; leafOf/verifyProof are pure). Flow: leafOf + verifyProof ->
// setRoot -> claim (operator-approved, records 1,000) -> collect (pays
// 1,000) -> double-collect + double-claim blocked.

// --- 2. FoldingPool V5 claim-then-collect (live) ---
console.log('\n-- FoldingPool V5 live claim-then-collect --');
const leafA = leafHash(agent.publicKey, CLAIM_A);
const leafB = leafHash(owner.publicKey, CLAIM_B);
const { root, layers } = buildTree([leafA, leafB]);
const proofA = getProof(layers, 0);
const rootHex = hex(root);
console.log('root:', rootHex, '| leafA:', hex(leafA), '| leafB:', hex(leafB));
console.log('proof element (leafB):', hex(proofA[0]));

const onChainLeaf: any = await pool.leafOf(agent.publicKey, CLAIM_A);
check('on-chain leafOf matches JS leaf', hex(onChainLeaf) === hex(leafA), `on-chain=${hex(onChainLeaf)}`);
const proofOk: any = await pool.verifyProof('0x' + hex(proofA[0]), '0x' + rootHex, '0x' + hex(leafA));
check('on-chain verifyProof accepts the right proof', proofOk === true);
const proofBad: any = await pool.verifyProof('0x' + hex(leafB), '0x' + rootHex, '0x' + hex(leafB));
check('on-chain verifyProof rejects a wrong proof', proofBad === false);

const rootFunder = await ownerFunder();
let r: any = await pool.setRoot(MONTH, '0x' + rootHex, sig(owner))
  .addInput({ txid: rootFunder.txid, vout: rootFunder.vout, satoshis: rootFunder.satoshis }, ownerUnlocker())
  .addOutput({ to: rootFunder.lock, amount: rootFunder.satoshis - FEE_BUDGET })
  .send();
console.log('setRoot tx:', txidOf(r));
const rootSeen: any = await waitFor('setRoot visible', async () => {
  const g: any = await pool.getRoot(MONTH);
  return hex(g) === rootHex ? g : null;
});
check('setRoot visible on-chain', true, `root=${rootHex}`);

const claimFunder = await ownerFunder();
r = await pool.claim(agent.publicKey, '0x' + hex(leafA), CLAIM_A, ownerAddr, sig(owner))
  .addInput({ txid: claimFunder.txid, vout: claimFunder.vout, satoshis: claimFunder.satoshis }, ownerUnlocker())
  .addOutput({ to: claimFunder.lock, amount: claimFunder.satoshis - FEE_BUDGET })
  .send();
console.log('claim tx:', txidOf(r));
const recorded: any = await waitFor('claim recorded (claims[leaf]=1000)', async () => {
  const c = BigInt(await pool.claims('0x' + hex(leafA)));
  return c === CLAIM_A ? c : null;
});
check('claim recorded (claims[leaf]=1000, no payout yet)', recorded === CLAIM_A);
const claimedFlag: any = await waitFor('claim visible (claimed flag 1)', async () => {
  const c = BigInt(await pool.claimed('0x' + hex(leafA)));
  return c === 1n ? c : null;
});
check('claim executed (claimed[leaf]=1)', claimedFlag === 1n);

// Collect pays the recorded 1,000 to the owner (agent's payout address).
const collectFunder = await ownerFunder();
r = await pool.collect('0x' + hex(leafA), sig(agent))
  .addInput({ txid: collectFunder.txid, vout: collectFunder.vout, satoshis: collectFunder.satoshis }, ownerUnlocker())
  .addOutput({ to: collectFunder.lock, amount: collectFunder.satoshis - FEE_BUDGET })
  .send();
console.log('collect tx:', txidOf(r));
const collected: any = await waitFor('collect paid (claims[leaf]=0)', async () => {
  const c = BigInt(await pool.claims('0x' + hex(leafA)));
  return c === 0n ? c : null;
});
check('collect paid 1,000 (claims[leaf]=0)', collected === 0n);

// Double-collect must fail (amount already zeroed).
let doubleCollectBlocked = false;
try {
  const bad: any = await pool.collect('0x' + hex(leafA), sig(agent));
  console.log('double-collect unexpectedly returned:', txidOf(bad));
} catch (e: any) {
  doubleCollectBlocked = true;
  console.log('double-collect rejected:', String(e?.message ?? e).slice(0, 200));
}
check('double-collect blocked', doubleCollectBlocked);

// Double-claim must fail (claimed flag already 1).
let doubleBlocked = false;
try {
  const bad: any = await pool.claim(agent.publicKey, '0x' + hex(leafA), CLAIM_A, ownerAddr, sig(owner));
  console.log('double-claim unexpectedly returned:', txidOf(bad));
} catch (e: any) {
  doubleBlocked = true;
  console.log('double-claim rejected:', String(e?.message ?? e).slice(0, 200));
}
check('double-claim blocked', doubleBlocked);

console.log('\n== SMOKE SUMMARY ==');
for (const [name, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `ALL ${results.length} CHECKS GREEN on Chipnet` : `${failed}/${results.length} CHECKS FAILED`);
if (failed > 0) process.exitCode = 1;
