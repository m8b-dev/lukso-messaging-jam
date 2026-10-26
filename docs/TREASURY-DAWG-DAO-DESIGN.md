# UP Dawg — DAWG token, treasury & UP-as-DAO (design, NOT deployed)

Status: **design / iteration only**. Nothing here is deployed. The DAWG token,
treasury vault, airdrop-on-announce, and the relayer clawback are to be hardened
and iterated before any mainnet deploy. DAO/management concept is B's; this doc
captures the shape we can build toward and the security hinges that must hold.

## 0. What already exists (proven on mainnet, in `poc/lab-ups/`)
- `DawgToken.sol` — minimal LSP7-shaped quota token: `balanceOf`, `mint` (owner
  only), `authorizeOperator(operator, amount, data)`, `authorizedAmountFor`,
  `getOperatorsOf`, `transfer(from,to,amount,force,data)` with **operator
  allowance enforcement** (when `msg.sender != from`, it checks and decrements
  `_allowances[from][operator]`). 1 DAWG == 1 relayed blob post.
- `blob-relayer-token-spike.mjs` — proves the full loop end to end:
  1. **charger station**: treasury `mint(userUP, 10)` — "come in, get 10 dawgs".
  2. user **authorizeOperator(relayer, ALL, data)** ONCE via `UP.execute` (the
     extension can sign this calldata tx — it is NOT type-3).
  3. relayer `/execute`: builds the **type-3** blob tx (blobs+kzg), posts the
     blob, then **chargeback** `transfer(userUP → relayerOperator, 1)` — pulls 1
     DAWG against the standing allowance. Allowance caps the blast radius.
  4. negative: a stock type-2 relayer reverts `BlobHashMismatch` (why generic UP
     relayers can't do blobs).
- `blob-relayer-server.mjs` — the live relayer; `REQUIRE_DAWG` gate is **stubbed
  (501)**, i.e. metering is OFF today. This is the switch to wire for public use.
- Real deploy target for the token: the LSP7 preset (LSP7Mintable), not this
  hand-rolled stand-in; the relayer code is identical against the preset.

## 1. The economic loop (airdrop-on-announce → metered relay → clawback)
```
                 ┌─────────────┐  mint N DAWG on first announce   ┌────────┐
   new user ───▶ │  TREASURY   │ ───────────────────────────────▶│ userUP │
 (announce key)  │ (LSP9 Vault │                                   └───┬────┘
                 │  + DAWG     │  authorizeOperator(relayer, ALL) once  │
                 │  minter)    │ ◀─────────────────────────────────────┘
                 └─────┬───────┘       relayer pulls 1 DAWG / blob       │
                       │  transfer(userUP → treasury, 1) per relayed post│
                       └────────────────────────────────◀───────────────┘
```
- **Trigger**: a user's FIRST `RegistryV3.announce(convPub)` (their one-time
  encryption-key publish) is the signal to airdrop N DAWG from the treasury.
  Must be **once per UP** — see §4 sybil note.
- **Spend**: each gas-less blob post burns/pulls 1 DAWG from the user to the
  treasury (clawback). Out of DAWG ⇒ relayer refuses ⇒ user self-sends (pays
  own gas) or posts text. So DAWG is a *relayer credit*, not money.
- **Clawback destination**: the spike pulls to the relayer operator EOA; for the
  real system pull to the **treasury** (recycle credits) — relayer is operator,
  `to = treasury`. Keeps supply circulating, relayer never accumulates balance.

## 2. Treasury as an LSP9 Vault owned by a UP
- Treasury = **LSP9 Vault** (asset segregation) whose owner is a **control UP**
  (not an EOA). DAWG minting rights + LYX for relayer gas live here.
- Why a UP owns it: lets us attach **multiple controllers with scoped LSP6
  permissions** → this is the DAO substrate (§3).

## 3. UP-as-DAO: per-controller permissions + allowances = governance
B's insight: one UP with **limited allowance per controller + different
permissions** is already DAO-like. LSP6 KeyManager supports exactly this.
- **LSP6 permission bits per controller**: CALL, SETDATA, ADDCONTROLLER,
  EDITPERMISSIONS, STATICCALL, DELEGATECALL (deny by default), plus
  **AllowedCalls** (restrict which `(address, function selector)` a controller
  may call) and **AllowedERC725YDataKeys** (restrict which settings it may edit).
- Mapping governance roles → controllers:
  | Role            | Permissions (scoped)                                           |
  |-----------------|----------------------------------------------------------------|
  | relayer EOA     | CALL only to `DAWG.transfer` + `Wall.postBlob` (AllowedCalls)  |
  | distributor bot | CALL only to `DAWG.mint(userUP, N)` (airdrop), capped          |
  | config admin    | SETDATA only on specific data keys (e.g. `distributionAmount`) |
  | treasury ops    | CALL to vault transfers / DEX pair forming, maybe multisig-gated|
  | root / DAO      | ADDCONTROLLER + EDITPERMISSIONS (can re-scope everyone)         |
- **Crucial settings as ERC725Y data keys** on the control UP (so changing them
  is a permissioned `setData`, auditable on-chain): `distributionAmount` (DAWG
  per announce), `relayerOperator`, `blobCreditPrice` (DAWG per post),
  `pauseAirdrop`, allowed DEX routers for pair-forming, etc.
- "manage treasury from the UP side (mint, change settings, send to DeFi, form
  pairs)" = each of those is a CALL/SETDATA a scoped controller is (or isn't)
  allowed to make. True DAO voting can sit **in front** (a governor contract
  added as a controller) later; the UP+KeyManager is the execution layer.

## 4. Security hinges (these MUST hold before any deploy)
1. **Allowance is the only thing standing between relayer and user funds.** The
   relayer is an LSP7 operator; it can pull *up to the authorized amount*. User
   must authorize a **bounded** amount, not unbounded, OR we accept "ALL dawgs"
   only because DAWG is a non-transferable-value relay credit (decide this).
   Re-check `DawgToken.transfer` allowance math on every change — it is the vault.
2. **Mint is owner-only.** In the UP-DAO, "owner" = the control UP; only a
   controller with CALL→`DAWG.mint` (AllowedCalls-scoped, capped) can airdrop.
   An over-broad CALL permission = infinite mint. Scope tightly.
3. **Airdrop sybil**: "N tokens on first announce" must be **once per UP** and
   UPs are cheap to deploy. Gate on something costlier than a fresh UP (e.g.
   require the UP to already hold an LSP3 profile / minimum account age / a
   proof), else it's a faucet to drain. Open question for B.
4. **Non-reentrancy / replay**: relayer chargeback uses the post's tx/nonce;
   keep the author-sig nonce anti-replay (already in `relay.ts` model).
5. **LSP9 vault controllers**: adding the distributor/relayer as vault operators
   must be minimal; never give the relayer SETDATA or ADDCONTROLLER.
6. **Pausability**: `pauseAirdrop` + ability to revoke the relayer operator in
   one `setData`/`authorizeOperator(relayer, 0)` call — kill switch.

## 4b. Encryption key in the client's OWN UP (not RegistryV3)
B: "post its encryption key in the client's UP rather than in the contract?"
**Yes — and it's more LUKSO-native.** Today `convPub` lives in
`RegistryV3.convPubOf[msg.sender]` (a mapping in a shared contract; see
`registry.ts` / `RegistryV3.sol:69`). Move it to **ERC725Y data on the user's
own UP**:
- Define a data key, e.g. `UPDawg:ConvPub` =
  `keccak256('UPDawg:ConvPub')` (or an LSP2 mapping key), value = the 32-byte
  X25519 pubkey.
- "Announce" becomes `UP.setData(UPDawg:ConvPub, convPub)` on the user's OWN
  account — self-sovereign, no shared registry write. A controller with SETDATA
  (scoped via AllowedERC725YDataKeys to just this key) can do it; the relayer
  can even sponsor it over LSP25 like any other calldata tx.
- **Read path**: `convPubOf(addr)` becomes `ERC725(addr).getData(UPDawg:ConvPub)`
  — one `getData` call per peer, no event scan. (Keep emitting a thin event, or
  rely on the DAO-follow registry §4c, for discovery/indexing.)

Trade-offs:
| aspect        | contract mapping (today)        | key in own UP (proposed)              |
|---------------|---------------------------------|---------------------------------------|
| sovereignty   | lives in our contract           | lives in the user's account (theirs)  |
| discovery     | 1 event stream, easy to index   | must know the addr first, or index it |
| rotation      | re-announce (new tx)            | `setData` overwrite (clean, native)   |
| portability   | tied to RegistryV3              | travels with the UP across any dapp    |
| airdrop hook  | listen `ConvPubAnnounced`       | listen `DataChanged(UPDawg:ConvPub)`  |
- **Impact on the §1 airdrop trigger**: the "first announce" signal moves from
  `ConvPubAnnounced` to the UP's own `DataChanged(key=UPDawg:ConvPub)` event
  (LSP0 emits `DataChanged`). Treasury/distributor watches that instead.
- Recommended: **hybrid** — key canonically in the user's UP (sovereign +
  portable), plus a lightweight on-chain "I exist / follow the DAO" marker in a
  registry for cheap discovery (next section).

## 4c. "UP must follow the DAO on-chain" — the membership edge
Separate from the key. B wants each client UP to **follow the DAO on-chain**.
Options, cheapest → richest:
1. **LSP26 Follower System** (LUKSO's native social-graph standard): the client
   UP calls `follow(daoUP)` on the canonical LSP26 registry. Public, indexable,
   zero custom contract, already supported by LUKSO explorers/mini-apps. The DAO
   enumerates followers to know its members. **Recommended** — it's exactly
   "follow on-chain" and we write no contract.
2. **DAWG hold = membership** (implicit): holding ≥1 DAWG already proves the
   airdrop fired. No explicit follow; membership = balance. Cheapest, but no
   social-graph surface.
3. **DAO-side registry** (custom): a `members` mapping the DAO UP (or a scoped
   controller) writes on first announce. Full control, but a contract to secure.
- **Gate chaining**: the §4.3 sybil gate can *require* an LSP26 follow (or a
  minimum-age LSP3 profile) before the airdrop mints — "follow the DAO, publish
  your key in your own UP, get N DAWG". The follow is the membership proof; the
  key-in-UP is the capability; the airdrop is the reward.

## 5. Open items (awaiting B)
- DAO management concept (B will drop it) — how proposals/voting front the UP.
- Vault functionality + management iteration (explicitly NOT frozen yet).
- DeFi: which DEX, pair (DAWG/LYX?), who may form pairs (scoped controller).
- Decide DAWG transferability: pure relay credit (soulbound-ish) vs tradeable.
- Sybil gate for the announce airdrop (§4.3).
- Confirm key-in-UP move (§4b): migrate `convPub` from RegistryV3 to a
  `UPDawg:ConvPub` ERC725Y key on each client UP (hybrid w/ discovery marker)?
- Confirm membership edge (§4c): LSP26 `follow(daoUP)` as the "follow the DAO
  on-chain" mechanism, chained into the airdrop gate?

## 5b. DECIDED (B, 2026-10-23) — tradeable DAWG, DeFi pair
- **DAWG is TRADEABLE**; there WILL be a **DAWG/LYX pair on a LUKSO DEX**. So
  DAWG carries real market value.
- **`blobCreditPrice = 1 DAWG` per post** (B corrected: "1 DAWG is 1 blob").
  The first airdrop is **N = 10 DAWG = 10 blob posts** ("10 blob send messages
  for the user to spend"). Token kept divisible (18 decimals) anyway so the DEX
  pair and any future sub-unit pricing stay flexible, but the credit unit is 1.
- → **Relayer allowance MUST be bounded** (hinge §4.1 resolved): because DAWG is
  now money, the user authorizes the relayer operator for a **capped amount**
  (e.g. a per-topup budget), NEVER "ALL dawgs". Top up by re-`authorizeOperator`.
- → **Supply MUST be capped** (hinge §4.2): token built on `LSP7CappedSupply`.
  Mint stays owner-only = treasury KeyManager, scoped per §3.
- → Governance can weight by DAWG held via **`LSP7Votes`** (ERC5805) — no second
  governance token needed when the DAO concept lands.

### Built so far (compiles, NOT deployed)
- `contracts/dao/DawgToken.sol` — real token = `LSP7Mintable + LSP7CappedSupply
  + LSP7Burnable + LSP7Votes` + a **soulbound transfer restriction** (choice B).
  **Verified: compiles against `@lukso/lsp7-contracts` with solc 0.8.37.** Owner
  = treasury control UP's LSP6 KeyManager. The only custom code is a transfer
  *restriction* in `_beforeTokenTransfer` (no value-moving logic): airdropped
  (minted-to-user) DAWG is soulbound/spend-only; treasury-minted & bought DAWG
  are free. `setTreasury` (owner-only) marks the exempt treasury address.

### Decisions finalized (B, 2026-10-23)
- 1 DAWG = 1 blob post; airdrop N = 10 DAWG; airdropped DAWG **soulbound** (B);
  sybil gate = **LSP3 profile + LSP26 follow**; relayer allowance **bounded**;
  supply **capped**; convPub moves to the user's **own UP**; LSP26 `follow` is
  the membership edge. DAO governance concept: see **`docs/DAO-CONCEPT.md`**.
- Verified LSP7 fact: `authorizeOperator` has **no balance check** → a user can
  authorize the relayer before holding any DAWG (onboarding order is free).
- Verified LSP7 fact: an operator allowance **cannot** gate the owner's own
  transfers/DEX sales (owner's self-transfer skips the allowance path) — that is
  why airdrop dumping is stopped by soulbound + sybil gate, NOT by allowance.

## 6. Explicitly NOT doing yet
- No deploy of token, vault, or DAO. No turning on `REQUIRE_DAWG`. No public
  relayer exposure. This doc is the thing we iterate; code follows once the
  vault/DAO shape and the §4 hinges are agreed.
