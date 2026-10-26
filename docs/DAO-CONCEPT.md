# UP Dawg — DAO concept (Z's proposal, NOT deployed)

B asked Z to design the DAO. This is the governance layer that sits on top of
`TREASURY-DAWG-DAO-DESIGN.md`. Design/iteration only — nothing deployed, no
`REQUIRE_DAWG`, no public relayer.

Decisions locked (B, 2026-10-23): DAWG tradeable (DAWG/LYX DEX pair); **1 DAWG =
1 blob post**; first airdrop **N = 10 DAWG**; **airdropped DAWG is soulbound**
(spend-only, choice B); sybil gate = **LSP3 profile + LSP26 follow of the DAO**;
relayer allowance **bounded**; supply **capped**.

## 1. Principle — the DAO is a Universal Profile, not a bespoke Governor
The DAO *is* a UP (the "control UP"). Its LSP6 KeyManager is the execution layer;
governance decides, the KeyManager enforces. We do NOT write a monolithic DAO
contract that holds funds and logic. Instead:
- **Treasury** = an LSP9 Vault owned by the control UP (assets segregated).
- **DAWG** = owned (mint rights) by the control UP's KeyManager.
- **Governance** = who may tell the KeyManager to do what, expressed as scoped
  LSP6 controllers. Voting (DAWG-weighted) front-runs the execution.

Why: LUKSO already gives us multisig-like, role-scoped, upgradeable governance
for free via LSP6. A custom Governor would re-implement it worse and add attack
surface over real (tradeable) value.

## 2. Roles as scoped LSP6 controllers (on the control UP)
Each controller is an address (EOA, bot, or another UP/contract) with a
permission bitmap + AllowedCalls + AllowedERC725YDataKeys. Least privilege:

| Controller        | PERMISSIONS                    | AllowedCalls (to:selector)        | Can do                                  |
|-------------------|--------------------------------|-----------------------------------|-----------------------------------------|
| **Distributor**   | CALL                           | DAWG : `mint(address,uint256,..)` | airdrop N DAWG to a qualified UP        |
| **Relayer**       | CALL                           | DAWG : `transfer(from,to,..)` to treasury only | clawback 1 DAWG/post        |
| **Config admin**  | SETDATA                        | — (AllowedERC725YDataKeys: the settings keys only) | change `distributionAmount`, `blobCreditPrice`, `pauseAirdrop` |
| **DeFi operator** | CALL                           | DEX router : `addLiquidity`/`swap`; DAWG : `transfer` to router | form & manage the DAWG/LYX pair |
| **Treasury ops**  | CALL                           | Vault : transfer/execute          | move vault assets (ideally multisig)    |
| **Governor**      | ADDCONTROLLER + EDITPERMISSIONS| —                                 | re-scope everyone; the DAO's root power |

- A compromised Distributor can only mint (capped by supply + per-call limit),
  never move the treasury. A compromised Relayer can only pull DAWG to the
  treasury. The blast radius of each key is its row, nothing more.
- **Governor** is the sensitive one (it can re-scope all others). It should NOT
  be a hot EOA — it should be a multisig UP or the on-chain vote executor (§4).

## 3. Crucial settings = ERC725Y data keys on the control UP
Changing a parameter is a permissioned `setData`, on-chain and auditable. Keys
(LSP2-style, under a `UPDawg:` namespace):
- `UPDawg:DistributionAmount`  → uint256, DAWG per airdrop (start 10)
- `UPDawg:BlobCreditPrice`     → uint256, DAWG per post (1)
- `UPDawg:PauseAirdrop`        → bool kill switch
- `UPDawg:RelayerOperator`     → address of the current relayer
- `UPDawg:AllowedDexRouters`   → address[] the DeFi operator may touch
Only the Config admin controller (scoped by AllowedERC725YDataKeys to exactly
these keys) may write them. The Distributor/airdrop reads them at mint time.

## 4. Governance flow (DAWG-weighted, phased)
The token is `LSP7Votes` (ERC5805) → vote weight = DAWG held (checkpointed), so
no second token. Governance maturity in three phases so we never block on a full
DAO to ship:

- **Phase 0 (bootstrap / now):** B's UP is the Governor (single trusted root).
  All scoped controllers above exist; B can re-scope. Ship the product.
- **Phase 1 (multisig):** Governor becomes a small multisig UP (founders). Still
  off-chain decision, on-chain execution. Removes the single hot key.
- **Phase 2 (on-chain vote):** add a **vote-executor contract** as the Governor
  controller. Proposals = (target, calldata) e.g. "setData BlobCreditPrice=2" or
  "mint 10k DAWG to treasury". DAWG holders vote via `LSP7Votes` snapshots;
  on pass, the executor tells the KeyManager to run the calldata. Quorum +
  timelock. Because execution is just "KeyManager runs calldata", ANY treasury
  action (mint, settings, DeFi, LP) is governable with no new plumbing.

Migration between phases = a single `EDITPERMISSIONS` setData swapping the
Governor controller. No redeploy.

## 5. Onboarding chain (how a user joins + gets credits)
1. **Gate (sybil):** client UP must have an **LSP3 profile** (not a bare UP) AND
   **follow the DAO** via LSP26 `follow(daoUP)`. Both cheap for real users, both
   cost a farmer gas + effort per fake identity.
2. **Capability:** user publishes their encryption key in **their OWN UP**
   (`setData(UPDawg:ConvPub, convPub)`), not in RegistryV3 (sovereign, portable).
3. **Reward:** the Distributor sees the (follow + LSP3 + first key-publish)
   signal and mints **10 soulbound DAWG** to the user UP.
4. **Authorize once:** user `authorizeOperator(relayer, bounded)` — allowed even
   at zero balance (verified: LSP7 `authorizeOperator` has no balance check), so
   this can happen before or after the airdrop.
5. **Spend:** each gas-less blob post = relayer pulls 1 DAWG to treasury
   (soulbound consumed first). Out of DAWG → self-send or text.
6. **Buy more:** when out, user buys DAWG on the DAWG/LYX pair; bought DAWG is
   free (not soulbound) and spends the same way.

## 6. Why soulbound airdrop + tradeable market DAWG coexist
- Airdropped (minted-to-user) DAWG is **soulbound** → farmers can't dump the
  faucet; credits can only be spent on posts (burn) or returned to treasury.
- DAWG the treasury seeds into the **DEX pair** is minted **to the treasury**,
  which is exempt (so the pair has real, transferable liquidity).
- DAWG a user **buys** arrived by transfer, not mint → free to re-trade.
This splits "earned credit you must use" from "owned asset you may trade",
enforced by a transfer *restriction* only (no value-moving custom code).

## 6b. Airdrop gate — BUILT + MAINNET-PROVEN (test names)
`contracts/dao/CreditDistributor.sol` implements the §5.1 gate as a contract:
- `eligible(up) -> (bool, reason)` gas-free view; `claimFor(up)` mints N once.
- Gate = `LSP26.isFollowing(up, dao)` AND `up.getData(LSP3Profile) != ""`.
- `claimed[up]` enforces once-per-UP; `distributionAmount`/`paused` are owner-set
  here (prod reads them from the control UP's ERC725Y settings keys).
- Minting: Distributor is the token owner in the spike (so `mint` works); in prod
  it is a scoped LSP6 CALL→`mint` controller (§2), no change to the gate logic.

Proven on LUKSO mainnet (`poc/lab-ups/distributor-e2e.mjs`, result json beside it,
**total 0.00411 LYX**): bare alice UP rejected ("not-following-dao", claim reverts);
set LSP3 profile → still rejected; `follow(dao)` → `eligible` flips true; `claimFor`
mints 10 **soulbound** (balance 10, soulbound 10); second claim reverts
AlreadyClaimed; bob (bare) stays rejected. token `0x2b2f…c9Ff`, dist `0x4F05…bB4d`.

## 6c. LSP9 Vault treasury — BUILT + MAINNET-PROVEN (real vault, no EOA)
The treasury is now a real **LSP9 Vault owned by a control UP** (not the EOA
stand-in). Proven on mainnet (`poc/lab-ups/vault-treasury-e2e.mjs`, result json,
**0.00503 LYX**, vault `0xe3e10f58…c3fc8D`):
1. deploy Vault (owner = EOA); 2. vault RECEIVES LYX + a free credit (treasury
seeds it; a *soulbound* credit canNOT move here — that restriction is what keeps
faucet credit on the user); 3. EOA owner moves assets via `vault.execute`;
4. **hand to the DAO**: `transferOwnership(controlUP)` + `acceptOwnership()`
relayed THROUGH the control UP's KeyManager (LSP14 2-step — pending owner accepts
in its own tx); owner() == control UP; 5. **governed move**: controller → LSP25
relay → `UP.execute(CALL, vault, 0, vault.execute(CALL, dest, value))` pays out,
driven only through the KeyManager; 6. NEGATIVE: a different UP's attempt to call
`vault.execute` reverts, vault balance unchanged. So any treasury action is a
KeyManager-gated `execute` — exactly the §4 governance path, no bespoke logic.
(Spike uses alice UP as the control-UP stand-in; prod = a dedicated DAO UP whose
KeyManager carries the §2 scoped role controllers.)

## 6d. "JUST UP" topology — BUILT + MAINNET-PROVEN (B's chosen direction)
B (2026-10-24): skip the DAO/governance layer for now — authority lives directly
on **one dedicated service UP**, not a DAO abstraction, not alice, not B's UP.
Proven on mainnet (`poc/lab-ups/svc-up-topology-e2e.mjs`, result json, **0.01814
LYX**). A fresh service UP **"dawgtestup"** (LSP3 name set) owns both the credit
token and the LSP9 vault; its KeyManager is the sole authority, exercised via
relayed `UP.execute`:
- service UP `0xD8711a18AC3b052A55cDc814418a6Ddd2e765655` (KM `0x767D…3E79`,
  fresh controller EOA in `.svc-up-key.json` — NOT reused from the lab UPs).
- token `0x900eA91d192953B67E0d9113343eF6f2aF324038`, **owner = the service UP**
  (not its KM: ERC725X CALLs via `UP.execute` originate from the UP address, so
  `onlyOwner` must see the UP; the UP is in turn gated by its KeyManager).
- vault `0xFa1bc7c4F8a85C0BE415dA85a63B4fC49ee9a679`, owner = service UP;
  `token.treasury` = vault, all set via relayed `UP.execute(CALL, …)`.
Proven: (4) gate-checked (LSP3 + LSP26 follow of the service UP) **mint runs as a
relayed `UP.execute(CALL, token, mint)`** — mint authority is literally the UP's
KeyManager, no Distributor-as-owner; alice gets 10 soulbound. (5) governed vault
payout `UP.execute(CALL, vault, vault.execute(CALL, dest, value))`. (6) NEGATIVE:
alice UP can neither mint (not token owner) nor drain the vault (not vault owner)
— both relayed attempts revert, balances unchanged.
Distributor contract is demoted to an off-chain/`eligible()` oracle in this
topology (it's no longer the token owner). Swapping to a real DAO later = one
`transferOwnership` + controller re-scope, no redeploy.

## 6e. Relayer as a least-privilege controller — BUILT + MAINNET-PROVEN
On the §6d service UP, the relayer EOA (`0x80B8…0135`) is now a scoped LSP6
controller that can trigger airdrops through the UP and **nothing else**. Proven
on mainnet (`poc/lab-ups/relayer-scoped-controller-e2e.mjs`, result json,
**0.00070 LYX**):
- Permissions = `CALL | EXECUTE_RELAY_CALL` (`0x…400800`). The relay-call bit is
  mandatory: a controller that submits meta-txs via `executeRelayCall` with CALL
  alone reverts `NotAuthorised(signer, "EXECUTE_RELAY_CALL")` (hit this live).
- AllowedCalls = one entry only: `(CALLTYPE_CALL, token, 0xffffffff, mint)` — so
  the UP call the relayer may drive is literally `token.mint`, nothing wider.
- The root controller adds/updates the relayer via a relayed `setDataBatch`
  (idempotent: on re-run it rewrites the relayer's Permissions/AllowedCalls in
  place, never re-appends to `AddressPermissions[]`).
Proven: (3) relayer `UP.execute(CALL, token, mint(alice,1))` **succeeds** (alice
+1 soulbound) — airdrop authority with no owner key; (4) relayer → vault move
**reverts** (vault not in AllowedCalls targets); (5) relayer → `token.transfer`
**reverts** (selector not allowed, only `mint`); (6) relayer → `setData` raising
its own Permissions to ALL **reverts** (no EDITPERMISSIONS/SETDATA). Blast radius
of a compromised relayer key = mint only, capped by supply — exactly §2's
Distributor row, now live on the service UP.

## 6f. UI-testable from the frontend — BUILT + PROVEN (dev panel)
The credit flow is now clickable inside the real UP Dawg wall (`frontend2`), not
just in poc scripts. A **🪙 Credits (test)** section tab (gated by
`VITE_CREDITS_PANEL`, default on) renders `src/screens/CreditsPanel.tsx`:
- **Balances** (credits / soulbound / free) read straight from chain via
  `src/lib/credits.ts` (`balanceOf` + `soulbound` on token `0x900e…`) — works
  with no wallet, no relayer.
- **Airdrop gate** shown live (LSP3 profile present + LSP26 follow of the
  service UP) with a one-click **follow now** (ERC725X `execute` of
  `LSP26.follow(serviceUP)` through the connected signer).
- **Claim airdrop** → POSTs the connected UP to the credit relayer, which mints
  N=10 soulbound credits via the service UP's scoped mint-only controller. The
  browser can't mint (no owner key; the UP extension can't sign the LSP25 raw
  digest), so minting goes through the relayer by design.

Mint path = `poc/lab-ups/credit-relayer-service.mjs`, a tiny HTTP service that
wraps the proven scoped controller (`relayer-scoped-controller-e2e`): endpoints
`GET /gate`, `GET /balance`, `POST /claim` (once-per-UP ledger, 0.5 LYX cap,
CORS-open). Frontend points at it via `VITE_CREDIT_RELAYER_URL` (build-time);
unset → panel is read-only and Claim is disabled.

PROVEN live (2026-10-24): service `/gate` for alice → eligible (LSP3 ✅ + follows
✅); `/balance` → 11 soulbound; `POST /claim` minted 10 more (tx `0x201b44f8…`,
11→21 soulbound) and a repeat returned `409 already-claimed`. `frontend2` builds
clean (tsc+vite) with the panel; headless render of the built preview = `#root`
1 child, no console/page errors. Services were run locally for the test and
stopped after. NOT production: TEST token, dev-only panel, no auth on the relayer
beyond the gate + once-flag + spend cap.

## 7. Open / next
- DEX choice on LUKSO (which router) → fixes DeFi-operator AllowedCalls.
- Per-call mint cap for the Distributor (belt to the supply cap).
- Timelock + quorum numbers for Phase 2.
- Whether the Governor Phase-1 multisig is an LSP6 multi-controller UP or an
  external multisig contract added as one controller.
- Dedicated DAO control UP (not a lab UP stand-in) carrying the §2 scoped
  controllers. (Relayer→mint controller now DONE on the service UP, §6e.)

## 8. NOT doing yet
No deploy of token, vault, DAO, or vote executor. No DEX pair. No relayer
metering switched on. This is the concept to iterate.
