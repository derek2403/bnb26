// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IAggregatorV3, IHaltableFeed} from "../interfaces/IAggregatorV3.sol";
import {IScenarioFeed} from "../interfaces/IScenarioFeed.sol";
import {SplitConstants} from "../interfaces/SplitConstants.sol";

/// @title ScenarioFeed
/// @notice Team- or viewer-set demo price for ScenarioPool and per-judge sandboxes, deployed as EIP-1167 clones.
///         The price is bounded to [0.4x, 1.6x] of an anchor captured from the reference feed (AtlasMirror) at
///         initialize()/reset(), so a public setter cannot push it arbitrarily far. updatedAt is always
///         block.timestamp - staleBy, i.e. fresh unless the operator simulates staleness.
/// @dev Never used by a LIVE pool. Only reads the reference with staticcall (no state-changing external calls),
///      so no reentrancy guard is needed.
contract ScenarioFeed is Initializable, IScenarioFeed {
    /// @dev shock() bps outside (-1e4, +1e4).
    error BadShock(int256 bps);
    /// @dev getRoundData() for any round other than the current one.
    error UnknownRound(uint80 roundId);

    uint256 private constant BPS = SplitConstants.BPS;
    uint256 private constant MIN_BOUND_BPS = 4000;
    uint256 private constant MAX_BOUND_BPS = 16000;
    uint8 private constant DEFAULT_DECIMALS = 8;
    /// @dev Anchor cap: keeps anchor * 1.6 and every int256 <-> uint256 cast below far from overflow.
    int256 private constant MAX_ANCHOR = int256(uint256(type(uint128).max));

    /// @inheritdoc IScenarioFeed
    address public referenceFeed;
    /// @inheritdoc IScenarioFeed
    address public operator;
    /// @inheritdoc IScenarioFeed
    bool public publicSetter;
    /// @inheritdoc IHaltableFeed
    bool public halted;
    /// @inheritdoc IAggregatorV3
    uint8 public decimals;
    /// @notice Current round id (starts at 1; incremented on every price change).
    uint80 public roundId;
    /// @inheritdoc IScenarioFeed
    int256 public anchor;
    /// @notice Current answer, always inside [minAnswer(), maxAnswer()] of the anchor it was set against.
    int256 public answer;
    /// @inheritdoc IScenarioFeed
    uint256 public staleBy;

    /// @dev Locks the implementation; clones are initialized by SandboxFactory / deploy scripts.
    constructor() {
        _disableInitializers();
    }

    modifier onlySetter() {
        if (!publicSetter && msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    /// @inheritdoc IScenarioFeed
    /// @dev If the reference reports decimals but no usable answer, initialAnswer is interpreted in the
    ///      reference's decimals.
    function initialize(address reference_, address operator_, bool publicSetter_, int256 initialAnswer)
        external
        initializer
    {
        referenceFeed = reference_;
        operator = operator_;
        publicSetter = publicSetter_;

        (bool usable, int256 refAnswer) = _readReference(reference_);
        int256 a = usable ? refAnswer : initialAnswer;
        if (a <= 0 || a > MAX_ANCHOR) revert NoAnchor();
        anchor = a;
        answer = a;
        roundId = 1;
        decimals = _readDecimals(reference_);

        emit AnchorReset(a, msg.sender);
        emit PriceSet(1, a, msg.sender);
    }

    // ---------------------------------------------------------------- setters

    /// @inheritdoc IScenarioFeed
    function setPrice(int256 answer_) external onlySetter {
        _setAnswer(answer_);
    }

    /// @inheritdoc IScenarioFeed
    function shock(int256 bps) external onlySetter {
        if (bps <= -int256(BPS) || bps >= int256(BPS)) revert BadShock(bps);
        // answer > 0 and (BPS + bps) in (0, 2*BPS): the product is positive.
        uint256 next = Math.mulDiv(uint256(answer), uint256(int256(BPS) + bps), BPS, Math.Rounding.Floor);
        _setAnswer(int256(next));
    }

    /// @inheritdoc IScenarioFeed
    function reset() external onlySetter {
        (bool usable, int256 refAnswer) = _readReference(referenceFeed);
        if (usable) anchor = refAnswer;
        int256 a = anchor;
        answer = a;
        staleBy = 0;
        halted = false;
        uint80 id = roundId + 1;
        roundId = id;
        emit AnchorReset(a, msg.sender);
        emit StalenessSet(0);
        emit HaltSet(false);
        emit PriceSet(id, a, msg.sender);
    }

    /// @inheritdoc IScenarioFeed
    function setStaleness(uint256 staleBy_) external onlyOperator {
        staleBy = staleBy_;
        emit StalenessSet(staleBy_);
    }

    /// @inheritdoc IScenarioFeed
    function setHalted(bool halted_) external onlyOperator {
        halted = halted_;
        emit HaltSet(halted_);
    }

    // ------------------------------------------------------------------ views

    /// @notice Lowest settable answer: ceil(anchor * 0.4).
    function minAnswer() public view returns (int256) {
        return int256(Math.mulDiv(uint256(anchor), MIN_BOUND_BPS, BPS, Math.Rounding.Ceil));
    }

    /// @notice Highest settable answer: floor(anchor * 1.6).
    function maxAnswer() public view returns (int256) {
        return int256(Math.mulDiv(uint256(anchor), MAX_BOUND_BPS, BPS, Math.Rounding.Floor));
    }

    /// @inheritdoc IAggregatorV3
    function description() external pure returns (string memory) {
        return "SCENARIO (team-set price)";
    }

    /// @inheritdoc IAggregatorV3
    function version() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc IAggregatorV3
    function latestRoundData()
        external
        view
        returns (uint80 roundId_, int256 answer_, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint256 t = _timestamp();
        uint80 id = roundId;
        return (id, answer, t, t, id);
    }

    /// @inheritdoc IAggregatorV3
    function getRoundData(uint80 roundId_)
        external
        view
        returns (uint80, int256 answer_, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint80 id = roundId;
        if (roundId_ != id || id == 0) revert UnknownRound(roundId_);
        uint256 t = _timestamp();
        return (id, answer, t, t, id);
    }

    // --------------------------------------------------------------- internal

    function _setAnswer(int256 a) private {
        int256 lo = minAnswer();
        int256 hi = maxAnswer();
        if (a < lo || a > hi) revert OutOfBounds(a, lo, hi);
        answer = a;
        uint80 id = roundId + 1;
        roundId = id;
        emit PriceSet(id, a, msg.sender);
    }

    function _timestamp() private view returns (uint256) {
        uint256 s = staleBy;
        return block.timestamp > s ? block.timestamp - s : 0;
    }

    /// @dev Total read of the reference answer: (false, 0) for address(0), a reverting feed, short return
    ///      data or a non-positive answer.
    function _readReference(address ref) private view returns (bool usable, int256 a) {
        if (ref == address(0)) return (false, 0);
        (bool ok, bytes memory ret) = ref.staticcall(abi.encodeCall(IAggregatorV3.latestRoundData, ()));
        if (!ok || ret.length < 160) return (false, 0);
        (, a,,,) = abi.decode(ret, (uint80, int256, uint256, uint256, uint80));
        usable = a > 0 && a <= MAX_ANCHOR;
    }

    /// @dev Reference decimals, or 8 when there is no reference, the call fails, or it reports more than 18.
    function _readDecimals(address ref) private view returns (uint8) {
        if (ref == address(0)) return DEFAULT_DECIMALS;
        (bool ok, bytes memory ret) = ref.staticcall(abi.encodeCall(IAggregatorV3.decimals, ()));
        if (!ok || ret.length < 32) return DEFAULT_DECIMALS;
        uint256 d = abi.decode(ret, (uint256));
        return d > 18 ? DEFAULT_DECIMALS : uint8(d);
    }
}
