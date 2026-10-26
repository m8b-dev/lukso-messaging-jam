# Dependency security review — 2026-10-26

## Audit results

Counts are npm dependency advisory nodes, including propagated findings, not distinct exploitable bugs. Registry results can change.

| Workspace | Before (critical/high/moderate/low) | After | Production-only after |
| --- | --- | --- | --- |
| `poc` | 63 (3/16/34/10) | **0** | **0** |
| `frontend2` | 21 (0/18/3/0) | **16 high** | **16 high** |

Both before audits were rerun before changes; after audits include development dependencies unless specified. No `npm audit fix --force` was used.

## PoC: remove unnecessary legacy JavaScript tooling

- Preserve ethers 6.17.0, kzg-wasm, WebRTC and EthereumJS runtime/demo dependencies. Move pinned Solidity compiler and LUKSO/OpenZeppelin source packages to `devDependencies`. Normal `npm ci` still installs all dependencies for existing compile/deploy demos; `npm ci --omit=dev` is for services that do not compile Solidity, such as the credit relayer. Demos that compile contracts need the full install.
- Override `solidity-bytes-utils` to **0.8.4**. The ERC725 source-package dependency previously pinned 0.8.0, which shipped an unnecessary production dependency on `@truffle/hdwallet-provider: latest`. That pulled in legacy web3, request, tar, elliptic and their advisories. Version 0.8.4 has no JS dependencies and preserves the Solidity library API. Its `BytesLib.sol` diff against 0.8.0 is only an `unchecked` block around the existing explicit slice-overflow check. Reviewed the published archive and compiled/tested contracts with it. This removes 560 installed packages rather than masking their advisories.
- Scope `tmp: 0.2.7` override to **solc 0.8.37**, fixing GHSA-7c78-jf6q-g5cm without changing compiler version or generated-contract settings.
- Compiler stays 0.8.37, Shanghai EVM, optimizer 200. No compiler or contract-source edits were necessary.

## Frontend: patched build tooling; preserve UP wallet compatibility

- Pin **Vite 6.4.5**, the maintained patched 6.x version, rather than accepting audit's proposed jump to 8.x. Installed React plugin 4.7.0 explicitly supports Vite 6; esbuild resolves to **0.25.12**, with the existing allowScripts entry updated accordingly. Vite/editor/dev-server and esbuild advisories no longer appear. This is a deliberate Vite major migration validated by typecheck and production build, not a claimed same-major patch.
- Narrow override under `@tailwindcss/typography`: **postcss-selector-parser 7.1.6** fixes GHSA-rj75-hqrm-r3gf. Reviewed the consumer's selector AST API usage and smoke-tested `astSync`, selector construction, node movement and serialization. Build passes. This transitive parser is stylesheet tooling, not relayer code.
- Do **not** force Zod 4 into dependencies declaring Zod 3. UP modal, web3-validator and wallet SDKs depend on Zod 3 APIs, validation/error semantics and typings. Latest published 3.x remains 3.25.76; Reown additionally pins 3.22.4. Audit's fix requires >=4.6.6. A blanket override would risk breaking wallet connection despite making audit look cleaner.

### Remaining advisory: GHSA-mrhx-c7xc-m3w5

[Zod oversized constrained-collection memory exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high, affects `<4.6.6`. The 16 high findings all propagate from this one advisory; there are no remaining critical, moderate or low findings. These are **browser runtime dependencies**, not merely build-only findings:

- `@lukso/up-modal@0.22.0 -> @lukso/web-components@1.207.0 -> web3-utils@4.3.3 -> web3-validator@2.0.6 -> zod@3.25.76`.
- `@lukso/up-modal -> @walletconnect/ethereum-provider@2.26.0 -> @reown/appkit@1.8.19 -> @reown/appkit-wallet@1.8.19 -> zod@3.22.4` (also propagated through AppKit controllers, pay, scaffold-ui, ui and utils).
- Coinbase SDK (`@coinbase/cdp-sdk@1.60.0`) and `abitype` use Zod 3; `abitype` also occurs under viem/ox/wallet libraries. Audit marks installed SDK/dependency paths; bundler tree-shaking is not proof they cannot execute.

Practical mitigation: serve only the static production build, never an exposed Vite dev/preview server; use trusted wallet providers, avoid untrusted WalletConnect sessions/payloads, and bound remotely supplied collection/body sizes **before** schema parsing at application/proxy boundaries where controlled. The latter is a deployment/application requirement, not a mitigation implemented by these manifest changes. A malicious wallet/provider response can still exhaust the browser tab; this is not a clean production audit. The credit-relayer Node dependency tree is separate and has zero audit findings. Full remediation requires upstream wallet/web3 packages that support fixed Zod, or separately reviewed adapter/library replacement with real wallet-connect regression testing. No claim is made that a successful build proves interactive UP connect.

## Verification

Run from the respective workspaces:

```sh
# poc
npm audit
npm audit --omit=dev
npm run compile:credits
npm run test:credits
node --test lab-ups/credit-relayer-test.mjs
# frontend2
npm audit                  # expected nonzero while Zod advisory remains
npm audit --omit=dev        # same 16 high findings
npm run typecheck
npm run build
```

Observed: credit compilation passes (DawgToken runtime 16,449 bytes; CreditDistributor 2,315 bytes; 27 compiler warnings); 18 offline EVM assertions pass; all 7 relayer tests pass. Frontend typecheck and production build pass (existing large-chunk warnings). Web3 validator accepts a valid address and rejects an invalid address after installation; typography parser API smoke checks pass. No credentials, RPC transactions, deployments, service changes or git commits were used in this dependency remediation.
