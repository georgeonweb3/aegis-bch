# AegisBCH — the Aegis spend guard, compiled to Bitcoin Cash

A port of [Aegis](https://github.com/georgeonweb3/aegis-base) (a spend-control
layer for AI agents, originally Solidity on Base) to Bitcoin Cash, compiled
with [SolidCash](https://solidcash.org) (`@solidcash/solidhat` 0.50.0,
`evmCompat: true`). Built for **BCH BLAZE 2026** (DoraHacks, Nov 14–22):

- **SolidCash bounty — 3.5 BCH**: "Build a Solidity smart contract that
  compiles natively to BCH with SolidCash, and runs on mainnet."
- **FoldingCash bounty — 0.5 BCH**: pull-based Merkle claims (see
  `contracts/FoldingPool.sol` and the
  [foldingcash-claims repo](https://github.com/georgeonweb3/foldingcash-claims)).

Live demo hub (all six BCH BLAZE entries):
https://georgeonweb3.github.io/bch-blaze-demos/

## Status (Nov 14, 2026)

| Piece | Result |
|---|---|
| `AegisBCH.sol` compiles | **8,908 bytes** — under the 10,000-byte per-input unlocking-script limit |
| `FoldingPool.sol` (V5) compiles | **6,191 bytes** — operator-approved pull (see "Known limits" 3) |
| Mock-network suite | **AegisBCH 4/4 green** (`npm run solidhat:test`): deploy, full guard flow (create → deposit → spend → freeze → spend-blocked → unfreeze → spend → withdraw → over-withdraw blocked, books balance 10,000 − 2,000 − 1,000 − 3,000 = 4,000), owner limit change + stranger rejection, stranger-spend rejection. **FoldingPool V5 6/6 green**: leafOf matches JS, claim records + collect pays, double-claim/double-collect blocked, verifyProof accepts/rejects, stranger signatures rejected |
| Chipnet deploy | **LIVE 2026-11-14 ~19:08 WAT** — AegisBCH `bchtest:rw28k9m5w3wyxptrkj6tx3mw6p4474meqfx596rkaz9eg5jsj2lv5pjm6q5kq` (tx `fac67a5e87c4f1248682820d0d721a3570df1d39c1d34f24daf4a9c47d4e8f30`, category `603e7a9320e8f1763e21f0b7ce65333576786cbed66be1548dee264e8064bda5`), FoldingPool V1 `bchtest:r0w6zluhvrfljqg3td5f07yecknumt3q6v6dzzze4a892rzeqs4p6scwr62ms` (tx `b4c44363314d06b872417f52ce820c1d7a0ea83c6929666f8dcc8585d6025686`) — V1 superseded by V5 below. Deployer funded by tbch.googol.cash faucet, 0.01017 tBCH (tx `70a4312bb3c59c5ede212074c058331708453e9b52a8b0292da5e28445443f71`); deployer balance after deploy ~0.00887 tBCH. Oracle pool category `b8e935d8c1dee63c9f91920542639f97088839f17fefa8bd8433b67168e953a6` (the pool funding txid — any later attach of AegisBCH must name it via `StatefulContract.at(..., { oraclePool })`; `ethers.getContractAt` cannot, and fails with the "pass oraclePool" error). |
| AegisBCH live flow (Chipnet) | **COMPLETE 2026-11-14 evening, all 4 txs confirmed (8 confirmations)**: create `83429147c3d114b741805fc69f21b2c4b7aa8932f12bfbd633b8986e79e37c38` → deposit 10,000 `ec2b6dfd73f3d3574922ec694f9f7f4897892adcdfd19c9a8277ef7643c0b027` → spend 2,000 `c789c7af50833e67ce31f0579509a59372650c487e967e0fd9ed70e220274b9b` (over-limit 99,000 blocked by live preflight) → withdraw 3,000 `8ebdba076f7e3996c4c7db4034e5a82cb2d162efc267448818fdbcd339a4727c` → balance **5,000**, books exact (10,000 − 2,000 − 3,000) |
| FoldingPool V5 live (Chipnet) | **DEPLOYED 2026-11-14 ~20:1x WAT** — `bchtest:rvpyzut9z2ckw6ryawl6q9hjpsf7jnpf9dwfhmhezwpkdse794cvsyu6rh5sv` (genesis tx `0ce114e3dfa5bce4b72f0e6dc9f308ff06be2f4747f352fef4f1a918b23ddb4b`, confirmed, 5 confs; category `f7e372e065c2aba86b6137c4ccd8acca046e916fff2539cf1b7b9b4e75d87e48`). Live smoke: on-chain `leafOf` matches the JS leaf, `verifyProof` accepts the right proof and rejects a wrong one, `setRoot` broadcast `abc22459f0f1bf2a110a03add0b264ca8a517209f10049e51fdb06c2ddfe241c`, `claim` broadcast `5bac2129571815f0c2cfb407131faa659c16dcb403abef4aed5a9850268a2082` (recorded 1,000), `collect` broadcast `a9f1388f850c83b6674ed2a6d3f79baf79e7fe835b42520bde480f5929290f53` — **all three state txs still in the mempool, unconfirmed** (chipnet block production stalled ~332350; the Aegis txs confirmed fine, so this is the testnet, not the txs). A resume script (`scripts/chipnet-pool-v5-resume.ts`) waits for the collect confirmation, then runs the double-collect/double-claim blocks. Root `6e3165959cd37d7bc9288c9412f162afcdfac8c940563791178234ed1e694394`, leafA `4c4f89a8952dc61d87e6b60fbeee10a3955b0f07ae535930a52dfe035c312ea3` |
| Mainnet deploy | Not yet — waits on George (PC access Monday Nov 16) |

## What the guard does

One contract, one agent per owner (create a second agent from another key
for a second guard). The owner holds the keys; the agent spends only inside
its policy.

- `createAgent(ownerKey, agentKey, ownerPayout, dailyLimit)` — register an agent.
- `deposit(agentKey, amount, ownerSig)` + `.withValue(amount)` — top up the
  agent's balance in satoshis. Owner-signed, so only the owner can credit
  their own agent.
- `agentSpend(agentKey, agentSig, to, amount)` — agent spends to a payee,
  capped by the daily limit (resets on `block.timestamp / DAY`) and the
  balance. Blocked while frozen.
- `setDailyLimit(agentKey, ownerSig, newLimit)`, `setFrozen(agentKey, ownerSig, bool)` — owner controls.
- `withdraw(agentKey, ownerSig, amount)` — owner pulls funds back to
  `ownerPayout`.
- `balanceOf(agentKey)` — the agent's spendable balance.

## How Aegis maps to BCH

| EVM Aegis (Base) | AegisBCH (SolidCash) |
|---|---|
| USDC (`transferFrom` / `transfer`) | Native BCH satoshis; the contract's satoshi container holds the funds |
| `msg.sender` auth | `checkSig(sig, storedPubkey)` — owner key and agent key are stored pubkeys; every spend path verifies a signature |
| `totalDeposited / totalSpent / totalWithdrawn` | One `balance` field (deposit adds, spend/withdraw subtract; `balanceOf` reads it directly) |
| Intents (`createIntent`, per-intent caps/deadlines) | **Off-chain in v1** — the full guard including intents lives in the [XO template](https://github.com/georgeonweb3/aegis-xo-template); the on-chain contract is the lean core that fits the 10,000-byte limit |
| Custom errors | `require()` — solidc 0.50.0 treats revert-with-custom-error as a no-op |
| Events | None — SolidCash records state, not logs, and events cost bytes |
| Auth modifiers | None — a modifier that reads the same entry the body writes emits duplicate stateful inputs; every function reads its entry once into `Agent storage a` and authorizes inline |

## Size ladder (measured)

The full port with intents compiled at **18,750 bytes** — undeployable.
Cutting it to fit, each step measured:

1. Remove the whole Intent system → 12,860
2. Custom errors → `require()`, drop `ownerToAgent` map and `getAgent` → 12,049
3. Remove all 7 events → 11,308
4. Three bookkeeping fields → one `balance` field, `freeze`/`unfreeze` → `setFrozen(bool)` → **9,650**
5. Auth modifiers → inlined checks → **9,059**
6. Deposit rework (declared amount + owner sig, see below) → **8,908**

## Known limits (honest)

**1. `deposit` credits a declared amount, it does not measure `msg.value`.**
SolidCash 0.50.0 only loads the satoshi container for functions that
transfer, and a payable function that only reads `msg.value` gets no
container slot in its block layout. Its covenant balance loops then fail
(`OP_VERIFY`) even when the container is loaded and funded — verified in
five mock variants (plain `msg.value`, + a zero transfer, + a 546-sat
receipt transfer, + `msg.value` credited raw, + `msg.value + 1`). So
`deposit(agentKey, amount, ownerSig)` credits the `amount` the caller
declares, and the caller attaches the same amount with `.withValue(amount)`.
The spend path is still capped by the container's **real** balance:
`agentSpend`/`withdraw` transfer satoshis out of the container, so no
funds can be created and an inflated state balance cannot be spent. A
production version verifies the deposit via the container diff once the
compiler supports measuring `msg.value` for deposit-only functions.

**2. Deploy seeds the satoshi container.** The container UTXO only exists
if the deploy carries `initialBalance` (or the container address is funded
directly). The deploy script seeds 10,000 sats; the seed stays in the
container, unaccounted in any agent balance. The mock fixtures do the same.

**3. `FoldingPool.claim` went through five versions — the framework rule that forced the final design.** V1 (keccak leaf + dynamic proof loop + transfer) failed the derive at the leaf bind; V2 (fixed-depth proof) passed the Merkle check but failed right before the transfer; V3 (claim-then-collect, no transfer in the claim) failed at the same point — so the transfer theory was wrong. V4 switched the hash to SHA-256 and still failed. A minimal probe (`contracts/HashWriteProbe.sol`, `test/HashWriteProbe.test.ts`) proved the rule on SolidCash 0.50.0: **a function that calls sha256 (or keccak256) AND writes state fails the derive — even one hash + one mapping write. A pure hash works (leafOf, verifyProof). A write without a hash works (setRoot).** V5 (current, 6,191 bytes) is operator-approved pull: `claim(pubkey, leaf, amount, payout, adminSig)` checks the admin signature, amount, and claimed flag, then records — no hash in the function. `collect(leaf, sig)` pays on the claimant's own signature. `verifyProof` is a public pure function the operator calls off-chain before signing, and anyone can audit an approval against the published root. The pool is funded once at deploy; claims are pulled by claimants (no trusted monthly push); the operator is the same party already trusted to publish the root. The Merkle tree + proofs verify 15/15 off-chain (`foldingcash-claims` repo, `demo.mjs`, SHA-256 since V4). Two compiler facts found on the way: `abi.encodePacked` cannot encode a `pubkey` (the leaf uses `hash160(pubkey)` instead — also the P2PKH address hash), and writing `true` to a `mapping(bytes32 => bool)` fails the mock preflight, so the claimed flag is a `uint256` (0/1).

**4. `block.timestamp` is oracle-written.** SolidCash reads it from a block
oracle, not the chain clock; a day rollover waits on the oracle owner.
Accepted for the PoC. On a live network the deploy must mint an oracle pool
for the contract (`oraclePool: { create: { ownerKey, tip } }` in
`scripts/deploy.ts` — the electrum provider names no pool owner, and a live
network cannot supply its own tip, so the script fetches the current Chipnet
tip from the public explorer). No keeper process is running yet, so the
pool's timestamp stays at the deploy tip until a keeper runs; same-day demo
flows are unaffected, a day rollover needs the keeper.

**5. VM egress needs a forwarder for the Electrum WebSocket.** Direct egress
from this VM to `chipnet.bch.ninja:50004` never completes a WebSocket
handshake (TCP connects, the upgrade hangs; the same endpoint answers HTTP
426 in ~1.4s via the egress proxy). `scripts/ws-forward.mjs` (in
`~/workspace/scratch/bch-blaze/`) listens plain on 127.0.0.1:15004 and
forwards through the proxy (CONNECT + TLS, SNI preserved, cert verified);
`solidcash.config.ts` points Chipnet at it when `SOLIDCASH_ELECTRUM_LOCAL=1`.
The script lives at `~/workspace/scratch/bch-blaze/ws-forward.mjs`.
Verified live: Fulcrum 2.1.3 answered `server.version` through it, and the
Chipnet deploy ran through it.

## Run it

```sh
npm install          # offline-friendly: the SolidCash packages are cached
npm run solidhat:compile
npm run solidhat:test    # mock network, 4/4
```

Chipnet deploy (needs a chipnet mnemonic with test BCH — faucets:
https://tbch.googol.cash, https://faucet.chipnet.imaginary.cash).
On this VM, start the Electrum forwarder first (see Known limit 5):

```sh
node ~/workspace/scratch/bch-blaze/ws-forward.mjs  # keep running in its own shell
export SOLIDCASH_MNEMONIC_CHIPNET="$(cat .chipnet-mnemonic)"
SOLIDCASH_ELECTRUM_LOCAL=1 npx solidhat deploy --network chipnet
```

Mainnet deploy uses `SOLIDCASH_MNEMONIC_MAINNET` and `--network mainnet`
— do not run it without George's go-ahead and a funded deployer.

## Layout

```text
contracts/AegisBCH.sol     the guard (lean core)
contracts/FoldingPool.sol  pull-based Merkle claims for FoldingCash (V5, operator-approved)
contracts/HashWriteProbe.sol  minimal probe proving the hash+write derive rule
test/AegisBCH.test.ts      mock-network suite (4/4)
test/FoldingPool.test.ts   V5 mock suite (6/6)
test/HashWriteProbe.test.ts  probe suite (hash+write fails, write-only passes)
scripts/deploy.ts          chipnet/mainnet deploy (prints addresses, writes nothing)
scripts/deploy-pool-v5.ts  FoldingPool V5 deploy
scripts/chipnet-smoke.ts / chipnet-resume*.ts  AegisBCH live-flow smoke (complete)
scripts/chipnet-pool-v5-smoke.ts / chipnet-pool-v5-resume.ts  FoldingPool V5 live smoke + resume
scripts/probe-confirmations.mjs / probe-collect-tx.mjs  Electrum probes (via ws-forward.mjs)
solidcash.config.ts        networks: mock / regtest / chipnet / mainnet
```

## Bounty notes

- No filing fee, no KYC on any BCH BLAZE bounty (checked Nov 14).
- The SolidCash entry is this repo + the demo page + a video (bridge, XO
  and FoldingCash videos done and verified Nov 14; DID video done Nov 14).
  The FoldingCash entry additionally leans on
  [foldingcash-claims](https://github.com/georgeonweb3/foldingcash-claims)
  (Merkle JS 15/15, contract here).
