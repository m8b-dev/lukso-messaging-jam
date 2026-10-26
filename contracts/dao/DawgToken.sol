// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

// Experimental relay-credit SOURCE, not an audited production release.
// Existing deployed tokens are NOT changed by this source edit.
// LSP7Votes explicitly warns it is not formally audited. This composition and
// custom accounting require independent review. DAO expansion is deferred.
// Service price baseline: 1 credit/blob (1e18 base units), not enforced here.

import {LSP7Mintable} from
    "@lukso/lsp7-contracts/contracts/presets/LSP7Mintable.sol";
import {LSP7CappedSupply} from
    "@lukso/lsp7-contracts/contracts/extensions/LSP7CappedSupply.sol";
import {LSP7Burnable} from
    "@lukso/lsp7-contracts/contracts/extensions/LSP7Burnable.sol";
import {LSP7Votes} from
    "@lukso/lsp7-contracts/contracts/extensions/LSP7Votes.sol";
import {LSP7DigitalAsset} from
    "@lukso/lsp7-contracts/contracts/LSP7DigitalAsset.sol";
import {EIP712} from
    "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract DawgToken is LSP7Mintable, LSP7CappedSupply, LSP7Burnable, LSP7Votes {
    /// @param owner_ Treasury control UP address, NOT its LSP6 KeyManager.
    /// Controllers route KM -> UP.execute -> token; token sees the UP caller.
    /// @param tokenCap_ Hard cap in smallest units (18 decimals).
    constructor(
        string memory name_,
        string memory symbol_,
        address owner_,
        uint256 tokenCap_
    )
        LSP7Mintable(name_, symbol_, owner_, /* lsp4TokenType_ */ 0, /* isNonDivisible_ */ false)
        LSP7CappedSupply(tokenCap_)
        EIP712(name_, "1")
    {}

    // --- soulbound-until-spent (choice B) --------------------------------
    // Airdropped DAWG is a spend-only relay credit: it may only leave a holder
    // by being burned (spend-on-post) or returned to the treasury. DAWG a user
    // BUYS on the DEX is freely transferable. We distinguish the two by SOURCE:
    // tokens that entered a wallet via mint() are "earned" and locked; tokens
    // bought on the market were transferred in from another holder and are free.
    //
    // Custom accounting and restrictions require security review. Rules:
    //   mint  (from==0)           : always allowed (airdrop / DEX LP seed)
    //   burn  (to==0)             : always allowed (spend-on-post)
    //   to treasury               : always allowed (clawback / return)
    //   from treasury / minter    : always allowed (treasury funds the DEX pair)
    //   any other transfer of a wallet's EARNED balance : blocked
    // "earned" is tracked as a soulbound sub-balance per holder.

    address public treasury; // configured once, before any mint
    mapping(address => uint256) public soulbound; // earned (locked) DAWG per holder

    error DawgSoulboundLocked(address from, uint256 free, uint256 amount);

    error InvalidTreasury();
    error TreasuryAlreadySet();
    error TreasuryNotSet();
    event TreasurySet(address indexed treasury);

    function setTreasury(address t) external onlyOwner {
        if (treasury != address(0)) revert TreasuryAlreadySet();
        if (t == address(0) || t == address(this)) revert InvalidTreasury();
        treasury = t;
        emit TreasurySet(t);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount,
        bool, /* force */
        bytes memory /* data */
    ) internal virtual override {
        // A future treasury must never inherit a locked sub-balance.
        if (treasury == address(0)) revert TreasuryNotSet();
        // No balance movement means no locked-credit consumption.
        if (from == to) return;
        // mint: the newly minted amount is soulbound to the recipient UNLESS it
        // is being minted to the treasury (DEX LP seed / treasury reserve).
        if (from == address(0)) {
            if (to != treasury) soulbound[to] += amount;
            return;
        }
        // burn or send-to-treasury: consume soulbound first, then free balance.
        if (to == address(0) || to == treasury) {
            uint256 sb = soulbound[from];
            if (sb >= amount) soulbound[from] = sb - amount;
            else soulbound[from] = 0;
            return;
        }
        // treasury itself may move freely (fund the pair, pay out, etc.)
        if (from == treasury) return;
        // any other transfer: only the FREE (bought) portion may move.
        uint256 locked = soulbound[from];
        uint256 free = balanceOf(from) - locked;
        if (amount > free) revert DawgSoulboundLocked(from, free, amount);
    }

    // --- resolve multiple-inheritance override collisions ---
    // CappedSupply enforces the cap on mint; both it and the base define _mint.
    function _mint(address to, uint256 amount, bool force, bytes memory data)
        internal
        virtual
        override(LSP7DigitalAsset, LSP7CappedSupply)
    {
        super._mint(to, amount, force, data);
    }

    // Votes moves the vote checkpoint on every balance change; both it and the
    // base define _update. super chains base → Votes.
    function _update(address from, address to, uint256 value, bool force, bytes memory data)
        internal
        virtual
        override(LSP7DigitalAsset, LSP7Votes)
    {
        super._update(from, to, value, force, data);
    }
}
