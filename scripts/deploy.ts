// Deploy AegisBCH (+ FoldingPool) to the selected network.
//   solidhat deploy --network chipnet
//   solidhat deploy --network mainnet   (George's go-ahead + funded deployer only)
// Prints everything to stdout and writes nothing to disk.
// The deployer address comes from the network mnemonic (env):
//   SOLIDCASH_MNEMONIC_CHIPNET / SOLIDCASH_MNEMONIC_MAINNET
// Electrum networks never create funds: fund the deployer address FIRST
// (chipnet faucets: https://tbch.googol.cash, https://faucet.chipnet.imaginary.cash).
// Both contracts deploy with an initialBalance so the satoshi container
// UTXO exists for the first transfer (see README "Known limits" #2).
// NOTE: the AegisBCH deploy mints an oracle pool (block.timestamp reader).
// Its category is the pool FUNDING txid, which this script does not print:
// recover it with `node scripts/recover-pool-category.mjs` (it lists the
// deployer history; the pool funding tx is the one spending the faucet coin
// into a one-time P2PKH). Any later attach of AegisBCH must name that
// category (StatefulContract.at ..., { oraclePool: <category> }).

import { ethers, network } from '@solidcash/solidhat/hardhat3';

const SEED = 10_000n; // sats seeded into each contract's satoshi container
const POOL_SEED = 100_000n; // sats funding the FoldingPool claims

// --- Chipnet tip for the oracle pool -------------------------------------
// A live network cannot supply its own tip (only a simulator can), so fetch
// the current chipnet tip from the public explorer and pass its real fields.
// Values are the live tip at deploy time; difficulty is floored to an integer
// (the pool field is 4 bytes, the explorer reports a float). The contract
// reads only block.timestamp (and number, via locktime) — difficulty, size,
// totalFees and coinbase are carried unread, but they are still the real tip
// values, not filler. Coinbase = the tip coinbase tx's first P2PKH output.
function hexToBin(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function fetchChipnetTip() {
  const res = await fetch('https://chipnet.imaginary.cash/api/blocks?limit=1');
  if (!res.ok) throw new Error(`chipnet tip fetch failed: HTTP ${res.status}`);
  const block = (await res.json() as any).blockList[0];
  const p2pkh = (block.coinbaseTx.vout as any[]).find((v: any) =>
    typeof v.scriptPubKey?.hex === 'string' && v.scriptPubKey.hex.startsWith('76a914'));
  if (!p2pkh) throw new Error('chipnet tip: no P2PKH output in coinbase tx');
  const tip = {
    number: BigInt(block.height),
    timestamp: BigInt(block.time),
    difficulty: BigInt(Math.floor(block.difficulty)),
    size: BigInt(block.size),
    totalFees: BigInt(Math.round(block.totalFees * 1e8)),
    coinbase: hexToBin(p2pkh.scriptPubKey.hex),
  };
  console.log('oracle tip: height', block.height, 'hash', String(block.hash).slice(0, 16) + '...', 'time', block.time);
  return tip;
}

const [deployer] = await ethers.getSigners(1);
console.log('network:', network.name);
console.log('deployer:', await deployer.getAddress());

const aegisFactory = await ethers.getContractFactory('AegisBCH', deployer);
// AegisBCH reads block.timestamp for the daily-limit window, so it needs an
// oracle pool. The electrum provider names no pool owner, so mint one owned
// by the deployer key: { create: { ownerKey, tip } } (ownerKey = private-key
// bytes; the pool keeper signs updates with it). Only info coins are minted:
// the contract reads block.timestamp, never blockhash, so no ring slots.
// NOTE: nobody keeps this pool current after deploy (no keeper process is
// running yet), so its timestamp stays at the deploy tip until a keeper runs.
// Same-day demo flows are unaffected; a day-rollover needs the keeper.
const tip = await fetchChipnetTip();
const aegis = await aegisFactory.deploy({ initialBalance: SEED, oraclePool: { create: { ownerKey: (deployer as any).privateKey, tip } } });
await aegis.waitForDeployment();
console.log('AegisBCH:', await aegis.getAddress());
console.log('AegisBCH txid:', aegis.deploymentTransaction().txid);

const poolFactory = await ethers.getContractFactory('FoldingPool', deployer);
const pool = await poolFactory.deploy(deployer.publicKey, { initialBalance: POOL_SEED });
await pool.waitForDeployment();
console.log('FoldingPool:', await pool.getAddress());
console.log('FoldingPool txid:', pool.deploymentTransaction().txid);
console.log('adminKey (deployer pubkey):', Buffer.from(deployer.publicKey).toString('hex'));
