# UP Wall + DM — frontend2 design

A Facebook-wall-style dApp for Universal Profiles on LUKSO mainnet.

## Two surfaces, one feed-first UI

1. **Public wall post** (plaintext, on-chain)
   - `Wall.post(tag, encrypted=false, threadId=0, body=plaintextBytes)`
   - `tag` = optional @mentioned UP (0 = broadcast to everyone).
   - Anyone reads it — it's public, visible on the explorer. Like a wall post / tagging someone.

2. **DM** (encrypted, on-chain ciphertext, gated on announced keys)
   - Precondition: BOTH my UP and the peer UP have announced their X25519
     conv pubkey via `RegistryV3.announce(convPub)` (0x01AC…088c).
   - `threadId = keccak(sortedPair(me, peer))`; shared key = X25519(myConvPriv, peerConvPub) HKDF threadId.
   - Seal plaintext with that key → ciphertext; `Wall.post(peer, encrypted=true, threadId, ciphertext)`.
   - Only me and the peer can decrypt. Chain sees ciphertext only = the DM.

## Contracts (both LIVE on mainnet, chain 42)
- **Wall**: `0xd3a767c7fE981524810aF7bdE05FA6537B96f58E` (posts, public + encrypted)
- **RegistryV3**: `0x01AC2FE086C2D69923F199d47C85688aB2FA088c` (announce/convPubOf)

## Conv-key derivation (critical correctness note)
`deriveConvKey` signs a fixed domain string via the UP extension and HKDFs the
RAW signature bytes into the X25519 scalar. The bytes must be DETERMINISTIC and
reproducible by the same UP. We do NOT ecrecover the signature — the peer only
needs the announced convPub (public). Therefore **each UP announces its own key
by connecting in the extension**; we never fabricate another UP's announce from
a raw controller key (the extension's signature bytes may differ from a raw
personal_sign, which would make the key unreproducible). This is why the flow is
per-UP, step by step.

Wallets connect through the LUKSO connect modal (`@lukso/up-modal`: UP Browser
Extension or UP Mobile via WalletConnect; EOAs hidden). The key is reproducible
per **controller**, not per UP: the same UP via UP Mobile vs. the extension
derives a different convPub. Announce.tsx / Wall.tsx `KeyStatus` therefore never
replace a different published key without an explicit second click.

## Peers (lab UPs for you to DM)
- alice UP `0xA02B2b0cB13a87824B0e42C951de3B1a20ECbA5C`
- bob   UP `0xf380f128b69c5EC2dffafC7Dd3f80DFDed0f509C`

## Screens
- **Connect** — connect UP via extension.
- **Announce** — one-time publish of my conv pubkey (RegistryV3). Required before I can send/receive DMs.
- **Wall** — global feed (public posts decoded; DM ciphertext shown as 🔒 unless it's my thread and I can decrypt). Compose: public (optional @tag) OR pick a peer → DM.
- **DM thread** — per-peer (alice, bob). Shows the peer's announce status; only unlocks encrypted send once both announced. Decrypts my threads inline.

## Hosting
- Static Vite build, served by a user systemd service behind a TLS reverse
  proxy (set `base` to the proxy sub-path at build time).
- TLS termination at the proxy gives a secure context (not needed for wall/DM,
  but consistent with the other VPN apps).
