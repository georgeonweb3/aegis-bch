// Print the deployer address for the selected network (read-only).
//   SOLIDCASH_MNEMONIC_CHIPNET=$(cat .chipnet-mnemonic) solidhat run scripts/address.ts --network chipnet
import { ethers, network } from '@solidcash/solidhat/hardhat3';

const [deployer] = await ethers.getSigners(1);
console.log('network:', network.name);
console.log('deployer address:', await deployer.getAddress());
console.log('deployer pubkey:', Buffer.from(deployer.publicKey).toString('hex'));
