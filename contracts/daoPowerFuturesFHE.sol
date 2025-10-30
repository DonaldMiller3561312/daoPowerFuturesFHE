pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract DaoPowerFuturesFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchClosed;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event PowerSnapshotSubmitted(address indexed provider, uint256 indexed batchId, bytes32 encryptedPower, bytes32 encryptedTimestamp);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, bytes32 stateHash);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalPower, uint256 averagePower);

    error NotOwner();
    error NotProvider();
    error PausedError();
    error CooldownActive();
    error BatchClosedError();
    error InvalidBatchError();
    error ReplayError();
    error StateMismatchError();
    error DecryptionFailedError();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        currentBatchId = 1; // Start with batch 1
        cooldownSeconds = 60; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        isProvider[provider] = false;
        emit ProviderRemoved(provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsSet(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openNewBatch() external onlyOwner {
        currentBatchId++;
        isBatchClosed[currentBatchId] = false;
        emit BatchOpened(currentBatchId);
    }

    function closeCurrentBatch() external onlyOwner {
        if (isBatchClosed[currentBatchId]) revert BatchClosedError();
        isBatchClosed[currentBatchId] = true;
        emit BatchClosed(currentBatchId);
    }

    function submitPowerSnapshot(
        euint32 encryptedPower,
        euint32 encryptedTimestamp
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (isBatchClosed[currentBatchId]) revert BatchClosedError();

        _initIfNeeded(encryptedPower);
        _initIfNeeded(encryptedTimestamp);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit PowerSnapshotSubmitted(msg.sender, currentBatchId, FHE.toBytes32(encryptedPower), FHE.toBytes32(encryptedTimestamp));
    }

    function requestTotalAndAveragePower(uint256 batchId) external whenNotPaused {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatchError();
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }

        euint32 memory totalPower = FHE.asEuint32(0);
        euint32 memory count = FHE.asEuint32(0);

        // Placeholder: In a real DEX, this would iterate over actual encrypted orders/trades
        // related to the specified batchId. For this example, we'll simulate with dummy data.
        // The core FHE logic for aggregation remains the same.
        euint32 memory dummyPower1 = FHE.asEuint32(100); // Placeholder for actual encrypted data
        euint32 memory dummyPower2 = FHE.asEuint32(200); // Placeholder for actual encrypted data
        _initIfNeeded(dummyPower1);
        _initIfNeeded(dummyPower2);

        totalPower = totalPower.add(dummyPower1);
        count = count.add(FHE.asEuint32(1));

        totalPower = totalPower.add(dummyPower2);
        count = count.add(FHE.asEuint32(1));


        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalPower);
        cts[1] = FHE.toBytes32(count);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        emit DecryptionRequested(requestId, batchId, stateHash);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayError();
        // Security: Replay guard prevents processing the same requestId multiple times.

        DecryptionContext memory ctx = decryptionContexts[requestId];

        // Rebuild ciphertexts from current storage in the exact same order as in requestTotalAndAveragePower
        euint32 memory totalPower = FHE.asEuint32(0);
        euint32 memory count = FHE.asEuint32(0);
        euint32 memory dummyPower1 = FHE.asEuint32(100); // Must match logic in requestTotalAndAveragePower
        euint32 memory dummyPower2 = FHE.asEuint32(200); // Must match logic in requestTotalAndAveragePower
        _initIfNeeded(dummyPower1);
        _initIfNeeded(dummyPower2);

        totalPower = totalPower.add(dummyPower1);
        count = count.add(FHE.asEuint32(1));
        totalPower = totalPower.add(dummyPower2);
        count = count.add(FHE.asEuint32(1));

        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = FHE.toBytes32(totalPower);
        currentCts[1] = FHE.toBytes32(count);

        bytes32 currentHash = _hashCiphertexts(currentCts);
        // Security: State hash verification ensures that the contract's state relevant to the
        // decryption request has not changed since the request was made. This prevents
        // scenarios where an attacker could alter data after a request but before decryption.
        if (currentHash != ctx.stateHash) revert StateMismatchError();

        // Security: Proof verification ensures the cleartexts are authentic and correctly decrypted
        // by the FHE decryption provider network.
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert DecryptionFailedError();

        // Decode cleartexts in the same order they were requested
        (uint256 totalPowerCleartext, uint256 countCleartext) = abi.decode(cleartexts, (uint256, uint256));

        uint256 averagePowerCleartext = (countCleartext > 0) ? (totalPowerCleartext / countCleartext) : 0;

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, ctx.batchId, totalPowerCleartext, averagePowerCleartext);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 memory x) internal {
        if (!FHE.isInitialized(x)) FHE.init(x);
    }

    function _initIfNeeded(ebool memory x) internal {
        if (!FHE.isInitialized(x)) FHE.init(x);
    }

    function _requireInitialized(euint32 memory x) internal pure {
        if (!FHE.isInitialized(x)) revert("FHE: euint32 not initialized");
    }

    function _requireInitialized(ebool memory x) internal pure {
        if (!FHE.isInitialized(x)) revert("FHE: ebool not initialized");
    }
}