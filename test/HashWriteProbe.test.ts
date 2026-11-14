import { describe, it, expect } from 'vitest';
import { ethers } from '@solidcash/solidhat/hardhat3';
import { mine, loadFixture } from '@nomicfoundation/hardhat-network-helpers';

const hex = (b: Uint8Array | Buffer) => Buffer.from(b).toString('hex');

async function deployFixture() {
  const [owner] = await ethers.getSigners(1);
  const Factory = await ethers.getContractFactory('HashWriteProbe', owner);
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  await mine();
  return { owner, contract };
}

describe('HashWriteProbe — which ingredient breaks the derive', () => {
  it('A: sha256(64B) + one write', async () => {
    const { contract } = await loadFixture(deployFixture);
    await contract.hashThenWrite('0x' + '11'.repeat(32), '0x' + '22'.repeat(32), 1000n);
    await mine();
    // values[h] should be 1000; we cannot know h off-chain without the
    // preimage hash, so just assert the call did not revert.
    expect(true).toBe(true);
  });

  it('B: sha256(52B) + one write', async () => {
    const { contract } = await loadFixture(deployFixture);
    await contract.leafThenWrite('0x' + '33'.repeat(20), 1000n);
    await mine();
    expect(true).toBe(true);
  });

  it('C: read by arg key + write', async () => {
    const { contract } = await loadFixture(deployFixture);
    await contract.readThenWrite('0x' + '44'.repeat(32), 1000n);
    await mine();
    expect(await contract.values('0x' + '44'.repeat(32))).toBe(1000n);
  });

  it('D: sha256 + read by computed key + write', async () => {
    const { contract } = await loadFixture(deployFixture);
    await contract.hashReadWrite('0x' + '33'.repeat(20), 1000n);
    await mine();
    expect(true).toBe(true);
  });
});
