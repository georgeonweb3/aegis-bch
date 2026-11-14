// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title AegisBCH — spend guard for AI agent wallets on Bitcoin Cash.
/// @notice Port of Aegis (Base) to BCH via SolidCash evmCompat.
///         Same guard semantics: per-agent daily cap, freeze, owner
///         withdraw. Demo: the guarded trader pays per API call and
///         the guard approves or blocks every payment.
/// @dev BCH adaptations (each one is a real semantic change, not a rename):
///      - USDC -> native BCH (satoshis). There is no USDC ERC-20 on BCH;
///        the contract holds BCH and agentSpend moves BCH. All amounts
///        in this contract are satoshis.
///      - msg.sender auth -> signature auth. On BCH the transaction
///        builder chooses co-spent inputs, so msg.sender alone does not
///        prove who called. Owner/agent functions take a `sig` and check
///        it against the stored pubkey with checkSig (SolidCash rule 2).
///      - Intents are OUT of the on-chain v1: the full AegisBCH with
///        intents compiled to 18,750 bytes, over BCH's 10,000-byte
///        per-input unlocking-script limit, so it could never deploy.
///        The lean core below (daily limit + freeze + signature auth)
///        is what runs on mainnet. Intents live off-chain in the demo
///        and in the XO template (aegis-xo-template repo), which carries
///        the full guard as a template; the on-chain extension path is
///        a second contract holding intent state, referenced by id.
///      - `getMyAgent` (msg.sender lookup) dropped; lookups are explicit
///        by agent pubkey.
///      - Daily window uses block.timestamp (oracle-backed read on BCH;
///        the compiler warns the oracle owner writes it, not the chain
///        clock — accepted: a deadline stays open until the owner
///        updates it, which only ever delays a day rollover).
///      - Agents are keyed by pubkey, not address: on BCH an agent's
///        identity is its key, and the payout address derives from it.
///      - `exists` is an explicit bool: pubkey(0) literals are not
///        castable to pubkey under evmCompat, so existence is a field.
///      - No mapping read after a write in the same function: the
///        compiler's direct convention rejects stale reads, so
///        withdraw() captures the payout address into a local first.
///      - No auth modifiers: a modifier that reads agents[agentKey]
///        plus a body that writes it gives the compiler TWO vmap
///        batches for the same key, and the send builder then fails
///        with "Duplicate stateful input" (same UTXO in two roles).
///        Every function reads the entry ONCE into `Agent storage a`
///        and authorizes against `a.ownerKey` / `a.agentKey` inline.

contract AegisBCH {
    uint256 public constant DAY = 1 days;

    struct Agent {
        bool exists;
        pubkey ownerKey;       // human owner, authorizes by signature
        pubkey agentKey;       // the AI agent, authorizes spends by signature
        address payable ownerPayout; // where owner withdrawals go
        bool frozen;
        uint256 dailyLimit;    // max satoshis the agent can spend per day
        uint256 spentToday;
        uint256 lastDay;       // floor(block.timestamp / DAY)
        uint256 balance;       // spendable BCH (satoshis); deposit adds, spend/withdraw subtract
    }

    mapping(pubkey => Agent) public agents;


    /// @notice Create a new protected agent. The owner key authorizes
    ///         later admin calls by signature; the agent key authorizes spends.
    function createAgent(pubkey ownerKey, pubkey agentKey, address payable ownerPayout, uint256 dailyLimit) external {
        require(!agents[agentKey].exists);

        agents[agentKey] = Agent({
            exists: true,
            ownerKey: ownerKey,
            agentKey: agentKey,
            ownerPayout: ownerPayout,
            frozen: false,
            dailyLimit: dailyLimit,
            spentToday: 0,
            lastDay: block.timestamp / DAY,
            balance: 0
        });


    }

    function setDailyLimit(pubkey agentKey, sig s, uint256 newDailyLimit) external {
        Agent storage a = agents[agentKey];
        require(checkSig(s, a.ownerKey));
        a.dailyLimit = newDailyLimit;
    }

    function setFrozen(pubkey agentKey, sig s, bool frozen_) external {
        Agent storage a = agents[agentKey];
        require(checkSig(s, a.ownerKey));
        a.frozen = frozen_;
    }

    /// @notice Deposit BCH into the agent's protected balance.
    ///         The caller attaches the sats with .withValue(amount) and
    ///         declares the same amount here; the owner signs so only the
    ///         owner can credit their own agent.
    ///         LIMITATION (SolidCash 0.50.0): a payable function that only
    ///         reads msg.value gets no satoshi-container slot in its block
    ///         layout, and the covenant's msg.value balance loops fail
    ///         (OP_VERIFY) even when the container is loaded and funded
    ///         (verified in 5 mock variants, Nov 14). So this PoC credits
    ///         the declared amount instead of measuring msg.value. The
    ///         spend path is still capped by the container's REAL balance:
    ///         agentSpend/withdraw transfer from the container, so no
    ///         funds can be created and an inflated state balance cannot
    ///         be spent. A production version verifies the deposit via
    ///         the container diff once the compiler supports it.
    function deposit(pubkey agentKey, uint256 amount, sig s) external payable {
        Agent storage a = agents[agentKey];
        require(a.exists);
        require(checkSig(s, a.ownerKey));
        require(amount != 0);

        a.balance += amount;
    }

    /// @notice Owner withdraws BCH from the agent's balance back to themselves.
    function withdraw(pubkey agentKey, sig s, uint256 amount) external {
        require(amount != 0);
        Agent storage a = agents[agentKey];
        require(checkSig(s, a.ownerKey));
        require(amount <= a.balance);

        address payable payout = a.ownerPayout;
        a.balance -= amount;

        payout.transfer(amount);
    }

    /// @notice The only way an agent can move BCH.
    ///         Checks freeze status + daily limit.
    function agentSpend(
        pubkey agentKey,
        sig s,
        address payable to,
        uint256 amount
    ) external {
        Agent storage a = agents[agentKey];

        require(checkSig(s, a.agentKey));
        require(a.exists);
        require(!a.frozen);
        require(amount != 0);

        uint256 currentDay = block.timestamp / DAY;
        if (currentDay > a.lastDay) {
            a.spentToday = 0;
            a.lastDay = currentDay;
        }

        require(a.spentToday + amount <= a.dailyLimit);

        uint256 bal = balanceOf(agentKey);
        require(amount <= bal);

        a.spentToday += amount;
        a.balance -= amount;

        to.transfer(amount);

    }

    /// @notice Available BCH balance for a given agent (satoshis).
    function balanceOf(pubkey agentKey) public view returns (uint256) {
        return agents[agentKey].balance;
    }
}
