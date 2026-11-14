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
| `FoldingPool.sol` compiles | **6,579 bytes** |
| Mock-network suite | **4/4 green** (`npm run solidhat:test`): deploy, full guard flow (create → deposit → spend → freeze → spend-blocked → unfreeze → spend → withdraw → over-withdraw blocked, books balance 10,000 − 2,000 − 1,000 − 3,000 = 4,000), owner limit change + stranger rejection, stranger-spend rejection |
| FoldingPool claim on mock | **Blocked** (see "Known limits" — the claim path fails the mock derive/preflight; the Merkle logic itself is verified 15/15 off-chain in the foldingcash repo) |
| Chipnet deploy | Not yet run — needs a funded chipnet wallet (see `scripts/deploy.ts`) |
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

**3. `FoldingPool.claim` is unproven on the mock network.** The contract
compiles (6,579 bytes), the Merkle tree + proofs verify 15/15 off-chain
(`foldingcash-claims` repo, `demo.mjs`), and `leafOf` on-chain returns
exactly the JS leaf. But the full `claim` call fails the mock
derive/preflight with `OP_VERIFY` at an early instruction. Bisecting
showed no single piece is the culprit (checkSig, Merkle `_verify`,
transfer, and the claimed-flag each pass/fail identically alone; all four
off together passes), which points at a framework-side interaction in the
mock derive pass, not at the contract logic. It needs a Chipnet run to
settle. Two compiler facts found on the way: `abi.encodePacked` cannot
encode a `pubkey` (the leaf uses `hash160(pubkey)` instead — also the
P2PKH address hash), and writing `true` to a `mapping(bytes32 => bool)`
fails the mock preflight, so the claimed flag is a `uint256` (0/1).

**4. `block.timestamp` is oracle-written.** SolidCash reads it from a block
oracle, not the chain clock; a day rollover waits on the oracle owner.
Accepted for the PoC.

## Run it

```sh
npm install          # offline-friendly: the SolidCash packages are cached
npm run solidhat:compile
npm run solidhat:test    # mock network, 4/4
```

Chipnet deploy (needs a chipnet mnemonic with test BCH — faucets:
https://tbch.googol.cash, https://faucet.chipnet.imaginary.cash):

```sh
export SOLIDCASH_MNEMONIC_CHIPNET="<chipnet mnemonic>"
npx tsx scripts/deploy.ts   # prints the contract address + container address
```

Mainnet deploy uses `SOLIDCASH_MNEMONIC_MAINNET` and `--network mainnet`
— do not run it without George's go-ahead and a funded deployer.

## Layout

```text
contracts/AegisBCH.sol     the guard (lean core)
contracts/FoldingPool.sol  pull-based Merkle claims for FoldingCash
test/AegisBCH.test.ts      mock-network suite (4/4)
scripts/deploy.ts          chipnet/mainnet deploy (prints addresses, writes nothing)
solidcash.config.ts        networks: mock / regtest / chipnet / mainnet
```

## Bounty notes

- No filing fee, no KYC on any BCH BLAZE bounty (checked Nov 14).
- The SolidCash entry is this repo + the demo page + a video (in progress;
  rendering is blocked on the VM's dead Chrome — see the repo's issues if
  any). The FoldingCash entry additionally leans on
  [foldingcash-claims](https://github.com/georgeonweb3/foldingcash-claims)
  (Merkle JS 15/15, contract here).
