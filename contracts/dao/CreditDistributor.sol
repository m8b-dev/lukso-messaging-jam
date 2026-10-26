// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// CreditDistributor — the airdrop gate for UP Dawg relay credits. NOT DEPLOYED
// under final branding; built + proven with TEST NAMES.
//
// Mints N soulbound credits to a qualifying client UP, exactly ONCE per UP.
// Qualification (sybil gate, B-chosen):
//   (a) the UP FOLLOWS the DAO on-chain  — LSP26 isFollowing(up, dao)
//   (b) the UP has an LSP3 profile        — getData(_LSP3_PROFILE_KEY) != ""
// Both are cheap for real users and cost a farmer gas + effort per fake UP.
//
// HISTORICAL PROTOTYPE ONLY: not wired to the current service UP.
// claimFor calls token.mint DIRECTLY and requires this distributor to own the
// token. LSP6 controller permission alone does not work: a UP-owned token needs
// KM -> UP.execute -> token routing, which this prototype does not implement.
// Settings are local fields, not production governance integration.
// Follow + nonempty LSP3 is not proof of uniqueness or genuine UP identity:
// arbitrary contracts can implement getData. DAO work is deferred.

interface IMintableCredit {
    function mint(address to, uint256 amount, bool force, bytes calldata data) external;
}

interface ILSP26 {
    function isFollowing(address follower, address addr) external view returns (bool);
}

interface IERC725Y {
    function getData(bytes32 dataKey) external view returns (bytes memory);
}

contract CreditDistributor {
    // keccak256("LSP3Profile")
    bytes32 internal constant _LSP3_PROFILE_KEY =
        0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5;

    address public owner;            // prototype settings admin
    IMintableCredit public immutable token;
    ILSP26 public immutable followers; // LSP26 registry (canonical singleton)
    address public immutable dao;      // the DAO UP that users must follow

    uint256 public distributionAmount; // N credits per airdrop (settings key)
    bool public paused;                 // kill switch (settings key)

    mapping(address => bool) public claimed; // once per UP

    event Airdropped(address indexed up, uint256 amount);
    event SettingsChanged(uint256 distributionAmount, bool paused);

    error NotOwner();
    error Paused();
    error AlreadyClaimed(address up);
    error NotFollowingDao(address up);
    error NoLsp3Profile(address up);

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(
        address owner_,
        IMintableCredit token_,
        ILSP26 followers_,
        address dao_,
        uint256 distributionAmount_
    ) {
        owner = owner_;
        token = token_;
        followers = followers_;
        dao = dao_;
        distributionAmount = distributionAmount_;
    }

    function setSettings(uint256 distributionAmount_, bool paused_) external onlyOwner {
        distributionAmount = distributionAmount_;
        paused = paused_;
        emit SettingsChanged(distributionAmount_, paused_);
    }

    /// @notice View the gate result without spending gas on a revert.
    function eligible(address up) public view returns (bool ok, string memory reason) {
        if (paused) return (false, "paused");
        if (claimed[up]) return (false, "already-claimed");
        if (!followers.isFollowing(up, dao)) return (false, "not-following-dao");
        if (!_hasLsp3(up)) return (false, "no-lsp3-profile");
        return (true, "");
    }

    /// @notice Claim the one-time airdrop for `up`. Anyone may trigger it FOR a
    /// UP (e.g. the relayer sponsors the call); the credits always go to `up`,
    /// and `up` must itself satisfy the gate — so sponsoring a fake UP still
    /// requires that fake UP to follow + have a profile.
    function claimFor(address up) external returns (uint256 amount) {
        if (paused) revert Paused();
        if (claimed[up]) revert AlreadyClaimed(up);
        if (!followers.isFollowing(up, dao)) revert NotFollowingDao(up);
        if (!_hasLsp3(up)) revert NoLsp3Profile(up);

        claimed[up] = true;
        amount = distributionAmount;
        token.mint(up, amount, true, "");
        emit Airdropped(up, amount);
    }

    function _hasLsp3(address up) internal view returns (bool) {
        // A bare UP has an empty LSP3Profile value; a set-up profile is non-empty.
        try IERC725Y(up).getData(_LSP3_PROFILE_KEY) returns (bytes memory v) {
            return v.length > 0;
        } catch {
            return false;
        }
    }
}
