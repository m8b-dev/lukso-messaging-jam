# Test credits: scope and verification

This feature branch preserves the unfinished Credits UI and test-token experiments, and adds relayer durability/security fixes and offline contract regressions. It is not a production rollout.

## What the UI tests

Connect a UP, open **Credits**, inspect balances, follow the service UP, and request the gated test airdrop when the backend reports it is enabled. Wallet actions occur on LUKSO mainnet and can cost LYX. The claim endpoint sponsors minting only; it does **not** make the wall or existing blob relay enforce one-credit-per-post. Do not interpret a successful claim as proof of atomic post-and-charge enforcement.

The test gate is LSP3 presence plus LSP26 following. These are not proof of a unique human or strong Sybil resistance. Encryption-key publication and authenticated claim ownership are not enforced by the legacy prototype. Production use requires those policy decisions and stronger on-chain enforcement.

## Source versus deployment

The checked-in token source now fixes treasury initialization and locked-balance edge cases. Existing deployed contracts are immutable and have **not** been upgraded/redeployed by this correction pass. Historical `*-e2e-result.json` files contain public chain evidence from earlier runs, not fresh proofs of the changed source. The service topology result is also its address manifest. DAO design documents are historical proposals; DAO rollout remains deferred.

## Offline checks (no secrets or transactions)

```sh
cd poc
npm ci --ignore-scripts
npm run compile:credits
npm run test:credits
node --test lab-ups/credit-relayer-test.mjs
cd ../frontend2
npm ci
npm run typecheck
npm run build
```

Historical mainnet E2E scripts require explicit `UPDAWG_ALLOW_MAINNET_SEND=1` and an external `UPDAWG_KEY_DIR`. Do not run them as routine tests: some deploy or mint, and their per-process guards are not a shared task-budget ledger. Inspect each script and reconcile cumulative spend first. Their key filenames remain the historical dot-prefixed filenames.

## Publication boundary

Private keys, local environment files, mutable claim ledgers, node_modules and generated bundles are excluded. Public chain addresses/transaction hashes in result fixtures are deliberately retained. No `VITE_` value is secret: Vite embeds these values in the browser. Never supply long-lived reusable credentials through `VITE_` variables. Public Pages remains master-only; this feature branch adds offline CI without deploying Pages.

See [relayer operations](CREDIT-RELAYER.md), [contract review](CREDIT-CONTRACT-REVIEW.md), and the dependency security report for limitations.
