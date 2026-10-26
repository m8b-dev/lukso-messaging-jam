# Credit contract source review (2026-10-25)

## Reproduce without wallets or network calls

From the `poc/` directory:

```
npm ci --ignore-scripts
npm run compile:credits
npm run test:credits
```

Installation requires registry access/cache; compilation and VM tests themselves are offline.
Only poc/node_modules is used, never frontend2's transitive dependencies.
Direct compile dependencies are pinned: solc 0.8.37, @lukso/lsp7-contracts 0.16.8,
@openzeppelin/contracts 4.9.6. package-lock.json locks the full graph.
Compiler targets Shanghai, optimizer enabled with 200 runs.

Verified locally: both contracts compile; DawgToken runtime 16,449 bytes,
CreditDistributor 2,315 bytes. 27 dependency warnings concern future reserved
identifiers and deprecated memory-safe-assembly comments; no compile errors.
The offline EthereumJS VM suite exercises initialization, ownership, locked/free
balances, attempted treasury replacement, self-transfer invariants, treasury
spend, bounded operator allowance, burn, cap enforcement and revert rollback.
It does not prove UP/LSP6 integration, malicious receiver reentrancy, voting,
or full distributor behavior. It is not an audit.

## Source changes and accounting

- Previously setTreasury was mutable despite its “set once” comment. Naming a
  holder with locked credits as treasury lets that holder use the exemption,
  leaving soulbound > balance and potentially breaking later subtraction after
  treasury rotation. Treasury is now set once, nonzero, not the token itself;
  minting is blocked until configured. Select the correct treasury before mint.
- A self-transfer does not consume locked credits. The hook now explicitly
  returns without changing accounting. Both user and treasury self-transfer
  paths are tested for unchanged balances (the underlying LSP7 may reject them).
- Returned/burned credits consume locked first. Treasury receipts become free;
  treasury can redistribute them. This is trusted treasury behavior, not
  immutable/non-recyclable soulbinding. Locked credits are not a DEX asset.
- Supply cap is a circulating-supply cap, not a lifetime issuance cap: burning
  creates room for the owner to mint again.
- Owner documentation now says the treasury control **UP**, not KeyManager.
  A controller must route KM -> UP.execute -> token so msg.sender is the UP.
  The constructor itself does not validate that the chosen owner is a real UP.
- Price documentation now states the agreed **1 credit/blob** (1e18 units for
  this divisible token). Token methods do not enforce service pricing.
- Removed blanket audited/production claims. The dependency's LSP7Votes source
  explicitly says that extension is not formally audited. Existing vote
  inheritance is retained, without expanding the deferred DAO concept.

## Historical distributor is NOT current service integration

CreditDistributor calls token.mint directly. It only works when the distributor
itself is token owner; controller permissions on a UP do not change this call
path. It has no KM -> UP routing. It cannot configure the new token treasury
itself: setup must occur under an initial owner before any ownership handover.
No current service wiring is implied. Owner/settings are local prototype fields,
not governance or ERC725Y settings. There is no owner rotation API or constructor
address validation. A zero distribution can consume a claim; administrators must
avoid it. Nonempty LSP3 + following does not prove a genuine UP or unique human;
arbitrary contracts can emulate getData, and registry failures can revert.
These prototype limitations are documented, not extended into a DAO redesign.

## Production blockers / source is not deployment

These edits change local source only. **Existing deployed test tokens are not
patched**, and historical E2E result files do not establish parity with this new
source. No transaction, deployment, wallet read or live configuration change was
performed. A separately authorized deployment/migration, ownership/treasury
verification and deployed-bytecode comparison are required before claiming the
fixes protect a live service. Existing mainnet E2E scripts remain historical
and should not be mistaken for these safe offline commands.

Independent audit (including hooks, LSP1 callbacks, operator paths and Votes),
real scoped-UP ownership integration tests, and an explicit migration decision
remain blockers. Treasury immutability deliberately trades rotation capability
for a simple invariant; treasury compromise/recovery needs an operational plan.

npm install reported 63 dependency advisories (10 low, 28 moderate, 22 high,
3 critical). The LUKSO dependency chain includes solidity-bytes-utils -> old
Truffle tooling; these JavaScript packages are not part of deployed Solidity
bytecode, but need separate supply-chain review. Installation used
--ignore-scripts; no broad automated dependency upgrade was attempted.
