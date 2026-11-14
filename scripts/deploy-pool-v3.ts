// Deploy ONLY FoldingPool V3 (fixed-depth proof) to the selected network.
//   SOLIDCASH_MNEMONIC_CHIPNET="$(cat .chipnet-mnemonic)" SOLIDCASH_ELECTRUM_LOCAL=1 npx solidhat run scripts/deploy-pool-v3.ts --network chipnet
// V1 (loop proof) is deployed at bchtest:r0w6zluhvrfljqg3td5f07yecknumt3q6v6dzzze4a892rzeqs4p6scwr62ms
// and its claim is blocked by the SDK's fixed-slot + dynamic-loop band
// collision (derive fails at the leaf bind, ip 133). V2 is a fresh pool
// with a fresh category, so it needs its own keccak side-cars (see the
// smoke script). Prints the address + genesis txid; paste both into
// scripts/chipnet-pool-v2-smoke.ts before running it.
import { ethers, network } from '@solidcash/solidhat/hardhat3';

const POOL_SEED = 100_000n; // sats funding the FoldingPool claims

const [deployer] = await ethers.getSigners(1);
console.log('network:', network.name);
console.log('deployer:', await deployer.getAddress());

const poolFactory = await ethers.getContractFactory('FoldingPool', deployer);
const pool = await poolFactory.deploy(deployer.publicKey, { initialBalance: POOL_SEED });
await pool.waitForDeployment();
console.log('FoldingPool V3:', await pool.getAddress());
console.log('FoldingPool V3 txid:', pool.deploymentTransaction().txid);
console.log('adminKey (deployer pubkey):', Buffer.from(deployer.publicKey).toString('hex'));
