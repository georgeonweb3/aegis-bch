// Minimal probe: isolate WHY claim() fails the derive on SolidCash 0.50.0.
// Each function tests one ingredient of FoldingPool.claim, so the failing
// combination shows up directly on the mock network.
contract HashWriteProbe {
    mapping(bytes32 => uint256) public values;
    mapping(uint256 => bytes32) public roots;

    /// A: sha256 of a 64-byte preimage + ONE mapping write (computed key).
    function hashThenWrite(bytes32 a, bytes32 b, uint256 amount) external {
        bytes32 h = sha256(abi.encodePacked(a, b));
        values[h] = amount;
    }

    /// B: sha256 of a 52-byte preimage (like leafOf) + ONE mapping write.
    function leafThenWrite(bytes20 pkh, uint256 amount) external {
        bytes32 h = sha256(abi.encodePacked(pkh, amount));
        values[h] = amount;
    }

    /// C: NO hash — read a mapping by an ARGUMENT key, then write it.
    function readThenWrite(bytes32 key, uint256 amount) external {
        require(values[key] == 0);
        values[key] = amount;
    }

    /// D: sha256 + read by COMPUTED key + write (claim's shape, minus _verify).
    function hashReadWrite(bytes20 pkh, uint256 amount) external {
        bytes32 h = sha256(abi.encodePacked(pkh, amount));
        require(values[h] == 0);
        values[h] = amount;
    }

    function setRoot(uint256 monthId, bytes32 root) external {
        roots[monthId] = root;
    }
}
