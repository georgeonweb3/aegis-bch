import { describe, it, expect } from 'vitest';
import { ethers } from '@solidcash/solidhat/hardhat3';
import { mine, loadFixture } from '@nomicfoundation/hardhat-network-helpers';
import { SignatureTemplate } from '@solidcash/solidcash';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

// FoldingPool V4 (SHA-256 leaf/proof, claim-then-collect) on the mock network.
// V4 replaces keccak256 with the native OP_SHA256: on SolidCash 0.50.0 a
// function combining keccak256 with state writes fails the derive on live
// Chipnet in all three variants tried (V1 loop ip 133, V2 transfer ip 346,
// V3 no-transfer ip 466 — all OP_INPUTINDEX right after the _verify
// require). sha256 compiles with NO compute side-cars (externalLibraries:
// {}), so claim is a plain state-write function like setRoot.
// Amounts are satoshis. The mock does not auto-mine: mine() after every
// state tx. State does not survive between tests: loadFixture per test.

const MONTH = 202611n;
const CLAIM_A = 1_000n;
const CLAIM_B = 2_000n;

const sig = (signer: any) => new SignatureTemplate(signer.privateKey);
const hex = (b: Uint8Array | Buffer) => Buffer.from(b).toString('hex');
const amt32 = (n: bigint) => {
  const b = Buffer.alloc(32);
  b.writeBigUInt64BE(n, 24);
  return b;
};

function hash160(pubkey: Uint8Array): Buffer {
  return Buffer.from(ripemd160(sha256(Buffer.from(pubkey))));
}
function leafHash(pubkey: Uint8Array, amount: bigint): Buffer {
  return Buffer.from(sha256(Buffer.concat([hash160(pubkey), amt32(amount)])));
}
function hashPair(a: Buffer, b: Buffer): Buffer {
  const [x, y] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
  return Buffer.from(sha256(Buffer.concat([x, y])));
}
function buildTree(leaves: Buffer[]): { root: Buffer; layers: Buffer[][] } {
  const layers: Buffer[][] = [leaves];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(hashPair(cur[i], cur[i + 1]));
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}
function getProof(layers: Buffer[][], index: number): Buffer[] {
  const proof: Buffer[] = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    proof.push(layers[l][idx ^ 1]);
    idx >>= 1;
  }
  return proof;
}

async function deployFixture() {
  const [owner, agent, stranger] = await ethers.getSigners(3);
  const Factory = await ethers.getContractFactory('FoldingPool', owner);
  const contract = await Factory.deploy(owner.publicKey, { initialBalance: 100_000n });
  await contract.waitForDeployment();
  await mine();
  return { owner, agent, stranger, contract };
}

async function rootedFixture() {
  const f = await deployFixture();
  const leafA = leafHash(f.agent.publicKey, CLAIM_A);
  const leafB = leafHash(f.owner.publicKey, CLAIM_B);
  const { root, layers } = buildTree([leafA, leafB]);
  const proofA = getProof(layers, 0);
  await f.contract.setRoot(MONTH, '0x' + hex(root), sig(f.owner));
  await mine();
  // View getters return Uint8Array: convert before comparing.
  expect(hex(await f.contract.getRoot(MONTH) as unknown as Uint8Array)).toBe(hex(root));
  return { ...f, leafA, leafB, root, proofA };
}

describe('FoldingPool V5 (operator-approved pull, SHA-256 leaf)', () => {
  it('deploys on the mock network', async () => {
    const { contract } = await loadFixture(deployFixture);
    expect(await contract.getAddress()).toMatch(/^bchtest:/);
  });

  it('on-chain leafOf matches the JS leaf', async () => {
    const { agent, contract } = await loadFixture(deployFixture);
    const leaf = leafHash(agent.publicKey, CLAIM_A);
    const onChain: any = await contract.leafOf(agent.publicKey, CLAIM_A);
    expect(hex(onChain)).toBe(hex(leaf));
  });

  it('claim records, collect pays 1,000, doubles blocked', async () => {
    const { owner, agent, contract, leafA, proofA } = await loadFixture(rootedFixture);

    await contract.claim(agent.publicKey, '0x' + hex(leafA), CLAIM_A, owner.address, sig(owner));
    await mine();
    expect(await contract.claimed('0x' + hex(leafA))).toBe(1n);
    expect(await contract.claims('0x' + hex(leafA))).toBe(CLAIM_A);

    const agentContract = contract.connect(agent);
    await agentContract.collect('0x' + hex(leafA), sig(agent));
    await mine();
    expect(await contract.claims('0x' + hex(leafA))).toBe(0n);

    // Double-collect: amount already zeroed.
    await expect(agentContract.collect('0x' + hex(leafA), sig(agent))).rejects.toThrow();
    // Double-claim: claimed flag already 1.
    await expect(
      contract.claim(agent.publicKey, '0x' + hex(leafA), CLAIM_A, owner.address, sig(owner)),
    ).rejects.toThrow();
  });

  it('verifyProof accepts the right proof and rejects a wrong one', async () => {
    const { contract, leafA, leafB, root, proofA } = await loadFixture(rootedFixture);
    const ok: any = await contract.verifyProof('0x' + hex(proofA[0]), '0x' + hex(root), '0x' + hex(leafA));
    expect(ok).toBe(true);
    const bad: any = await contract.verifyProof('0x' + hex(leafB), '0x' + hex(root), '0x' + hex(leafB));
    expect(bad).toBe(false);
  });

  it('a claim without the operator signature is rejected', async () => {
    const { owner, agent, stranger, contract, leafA } = await loadFixture(rootedFixture);
    // Stranger (not the admin) signs the approval: must fail.
    await expect(
      contract.claim(agent.publicKey, '0x' + hex(leafA), CLAIM_A, owner.address, sig(stranger)),
    ).rejects.toThrow();
    expect(await contract.claims('0x' + hex(leafA))).toBe(0n);
  });

  it('stranger cannot collect someone else\'s claim', async () => {
    const { owner, agent, stranger, contract, leafA, proofA } = await loadFixture(rootedFixture);
    await contract.claim(agent.publicKey, '0x' + hex(leafA), CLAIM_A, owner.address, sig(owner));
    await mine();
    const strangerContract = contract.connect(stranger);
    await expect(strangerContract.collect('0x' + hex(leafA), sig(stranger))).rejects.toThrow();
    expect(await contract.claims('0x' + hex(leafA))).toBe(CLAIM_A);
  });
});
