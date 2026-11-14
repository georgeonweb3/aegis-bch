import { describe, it, expect } from 'vitest';
import { ethers } from '@solidcash/solidhat/hardhat3';
import { mine, loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { SignatureTemplate } from '@solidcash/solidcash';

// AegisBCH lean core on the mock network: daily limit + freeze + signature auth.
// Amounts are satoshis. Mock accounts are funded in-process; the mock chain
// does not auto-mine, so every state-changing tx is followed by mine().
// `sig` args take a SignatureTemplate built from the signer's private key:
// the builder signs the sighash preimage with it at tx-build time.
// Value goes through `.withValue()` on the call object, not the ethers
// `{ value }` override (which the stateful binding ignores).
// deposit() takes (agentKey, amount, ownerSig) and the caller attaches the
// same amount via .withValue(): SolidCash 0.50.0 cannot measure msg.value
// for a deposit-only function (its covenant balance loops fail OP_VERIFY),
// so the PoC credits the declared amount and the spend path stays capped
// by the container's REAL balance. Deploy seeds the satoshi container with
// initialBalance so the first transfer has a container UTXO to spend from.
// State does NOT survive between tests (snapshot isolation), so each test
// deploys through loadFixture and builds the state it needs.

const DAILY_LIMIT = 100_000n;
const DEPOSIT = 10_000n;

const sig = (signer: any) => new SignatureTemplate(signer.privateKey);

async function deployFixture() {
  const [owner, agent, stranger] = await ethers.getSigners(3);
  const Factory = await ethers.getContractFactory('AegisBCH', owner);
  // 10,000-sat container seed: the first transfer needs a container UTXO.
  // The seed stays in the container, unaccounted in any agent balance.
  const contract = await Factory.deploy({ initialBalance: 10_000n });
  await contract.waitForDeployment();
  await mine();
  return { owner, agent, stranger, contract };
}

async function fundedFixture() {
  const f = await deployFixture();
  await f.contract.createAgent(f.owner.publicKey, f.agent.publicKey, f.owner.address, DAILY_LIMIT);
  await mine();
  await f.contract.deposit(f.agent.publicKey, DEPOSIT, sig(f.owner)).withValue(DEPOSIT).send();
  await mine();
  return f;
}

describe('AegisBCH guard', () => {
  it('deploys on the mock network', async () => {
    const { contract } = await loadFixture(deployFixture);
    expect(await contract.getAddress()).toMatch(/^bchtest:/);
  });

  it('creates an agent, deposits, spends, freezes, withdraws — books balance', async () => {
    const { owner, agent, stranger, contract } = await loadFixture(deployFixture);

    await contract.createAgent(owner.publicKey, agent.publicKey, owner.address, DAILY_LIMIT);
    await mine();
    expect(await contract.balanceOf(agent.publicKey)).toBe(0n);

    await contract.deposit(agent.publicKey, DEPOSIT, sig(owner)).withValue(DEPOSIT).send();
    await mine();
    expect(await contract.balanceOf(agent.publicKey)).toBe(10_000n);

    const agentContract = contract.connect(agent);
    await agentContract.agentSpend(agent.publicKey, sig(agent), stranger.address, 2_000n);
    await mine();
    expect(await contract.balanceOf(agent.publicKey)).toBe(8_000n);

    // Over the daily limit: 2,000 spent, 99,000 more would total 101,000 > 100,000.
    await expect(
      agentContract.agentSpend(agent.publicKey, sig(agent), stranger.address, 99_000n),
    ).rejects.toThrow();
    expect(await contract.balanceOf(agent.publicKey)).toBe(8_000n);

    // Frozen: spend blocked; unfrozen: spend works.
    await contract.setFrozen(agent.publicKey, sig(owner), true);
    await mine();
    await expect(
      agentContract.agentSpend(agent.publicKey, sig(agent), stranger.address, 1_000n),
    ).rejects.toThrow();
    await contract.setFrozen(agent.publicKey, sig(owner), false);
    await mine();
    await agentContract.agentSpend(agent.publicKey, sig(agent), stranger.address, 1_000n);
    await mine();
    expect(await contract.balanceOf(agent.publicKey)).toBe(7_000n);

    // Withdraw 3,000 -> 4,000 left; withdrawing 5,000 is blocked.
    await contract.withdraw(agent.publicKey, sig(owner), 3_000n);
    await mine();
    expect(await contract.balanceOf(agent.publicKey)).toBe(4_000n);
    await expect(contract.withdraw(agent.publicKey, sig(owner), 5_000n)).rejects.toThrow();
    expect(await contract.balanceOf(agent.publicKey)).toBe(4_000n);

    // Books: 10,000 - 2,000 - 1,000 - 3,000 = 4,000.
  });

  it('lets the owner change the daily limit, and rejects strangers', async () => {
    const { owner, agent, stranger, contract } = await loadFixture(fundedFixture);
    await contract.setDailyLimit(agent.publicKey, sig(owner), 50_000n);
    await mine();
    await expect(
      contract.setDailyLimit(agent.publicKey, sig(stranger), 1n),
    ).rejects.toThrow();
  });

  it('rejects an agent spend signed by a stranger', async () => {
    const { agent, stranger, contract } = await loadFixture(fundedFixture);
    const strangerContract = contract.connect(stranger);
    await expect(
      strangerContract.agentSpend(agent.publicKey, sig(stranger), stranger.address, 1_000n),
    ).rejects.toThrow();
    expect(await contract.balanceOf(agent.publicKey)).toBe(10_000n);
  });
});
