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

import { ethers, network } from '@solidcash/solidhat/hardhat3';

const SEED = 10_000n; // sats seeded into each contract's satoshi container
const POOL_SEED = 100_000n; // sats funding the FoldingPool claims

const [deployer] = await ethers.getSigners(1);
console.log('network:', network.name);
console.log('deployer:', await deployer.getAddress());

const aegisFactory = await ethers.getContractFactory('AegisBCH', deployer);
const aegis = await aegisFactory.deploy({ initialBalance: SEED });
await aegis.waitForDeployment();
console.log('AegisBCH:', await aegis.getAddress());
console.log('AegisBCH txid:', aegis.deploymentTransaction().txid);

const poolFactory = await ethers.getContractFactory('FoldingPool', deployer);
const pool = await poolFactory.deploy(deployer.publicKey, { initialBalance: POOL_SEED });
await pool.waitForDeployment();
console.log('FoldingPool:', await pool.getAddress());
console.log('FoldingPool txid:', pool.deploymentTransaction().txid);
console.log('adminKey (deployer pubkey):', Buffer.from(deployer.publicKey).toString('hex'));
