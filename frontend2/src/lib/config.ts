// config.ts — all network / chain / endpoint constants in one place.
//
// Everything that may need to change for a prod deploy lives here and is
// documented. Nothing here is a secret.

/** LUKSO mainnet. */
export const CHAIN_ID = 42;

/**
 * RPC endpoints, tried in order (first that answers chainId 42 wins).
 * lukso.network is primary: it sends `access-control-allow-origin: *` AND isn't
 * rate-limited for browser origins. thirdweb (kept as fallback) 429s hard from a
 * GitHub Pages origin — it was blocking the feed/roster reads (CORS+429), see
 * the 2026-10-22 Pages console. Override via VITE_RPCS if needed.
 */
export const RPCS = [
  'https://rpc.mainnet.lukso.network',
  'https://42.rpc.thirdweb.com',
] as const;

/**
 * RegistryV3 address — LIVE on LUKSO mainnet.
 *
 * Deployed 2026-10-21 at 0x01AC…088c (tx 0xf571567b…59cd5). Superset of the
 * E2E-lab RegistryV2 `0xA5Be…2fcC` (announce + invite) plus the WebRTC
 * SDP/ICE session-signaling fields this frontend needs (see
 * `frontend/contracts/RegistryV3.sol`). Override via VITE_REGISTRY_ADDRESS
 * for a different deploy (e.g. testnet).
 */
export const REGISTRY_ADDRESS: string =
  (import.meta.env?.VITE_REGISTRY_ADDRESS as string | undefined) ??
  '0x01AC2FE086C2D69923F199d47C85688aB2FA088c';

/**
 * True once a RegistryV3 (with SDP/ICE fields) is wired in. The default
 * address above IS a live RegistryV3, so this is true by default; it only
 * goes false if someone overrides VITE_REGISTRY_ADDRESS with a non-V3
 * contract AND sets VITE_REGISTRY_IS_V2=1 to say so.
 */
export const REGISTRY_V3_DEPLOYED: boolean =
  (import.meta.env?.VITE_REGISTRY_IS_V2 as string | undefined) !== '1';

/**
 * ICE servers for connectivity. STUN (reflexive-address discovery, no media)
 * is always on. A TURN relay — needed for reliable connects between users on
 * strict/different NATs — is OPTIONAL and added only when the build provides
 * VITE_TURN_URL (plus optional username/credential). This keeps the site a
 * pure static deploy: TURN, when set, is just another external endpoint like
 * the RPC. Falls back to STUN-only when unset (works on friendly NATs / VPN).
 */
const TURN_URL = import.meta.env?.VITE_TURN_URL as string | undefined;
const TURN_USER = import.meta.env?.VITE_TURN_USERNAME as string | undefined;
const TURN_CRED = import.meta.env?.VITE_TURN_CREDENTIAL as string | undefined;

export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  ...(TURN_URL
    ? [
        {
          urls: TURN_URL,
          ...(TURN_USER ? { username: TURN_USER } : {}),
          ...(TURN_CRED ? { credential: TURN_CRED } : {}),
        } as RTCIceServer,
      ]
    : []),
];

/**
 * Envio mainnet indexer (GraphQL) for @name → UP address resolution.
 * Uses the `search_profiles_v2` field per FRONTEND-PLAN.md.
 */
export const ENVIO_GRAPHQL =
  'https://envio.lukso-mainnet.universal.tech/v1/graphql';

/**
 * WalletConnect (Reown) project id for the UP Mobile option in the connect
 * modal (@lukso/up-modal). Optional: unset (or empty) uses the package's shared
 * LUKSO default. A production deploy should set its own via
 * VITE_WALLETCONNECT_PROJECT_ID — it ships in the bundle, so it's public anyway.
 */
export const WALLETCONNECT_PROJECT_ID: string | undefined =
  (import.meta.env?.VITE_WALLETCONNECT_PROJECT_ID as string | undefined) || undefined;

/** LUKSO explorer for linking out to a UP / tx. */
export const EXPLORER = 'https://explorer.lukso.network';

/**
 * IPFS HTTP gateway for rendering LSP3 profile images. Envio returns image URLs
 * that are usually `ipfs://<cid>/<path>` (occasionally already https). The
 * LUKSO-run gateway at api.universalprofile.cloud is CORS-open for images and
 * serves the same content as the UP cloud. Override via VITE_IPFS_GATEWAY.
 */
export const IPFS_GATEWAY: string =
  (import.meta.env?.VITE_IPFS_GATEWAY as string | undefined) ??
  'https://api.universalprofile.cloud/ipfs/';

/**
 * Turn an LSP3 image URL into something an <img src> can load: `ipfs://CID/x`
 * → `${IPFS_GATEWAY}CID/x`; http(s) and data URLs pass through untouched.
 * Returns null for empty/unusable input.
 */
export function ipfsToHttp(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('ipfs://')) {
    return IPFS_GATEWAY.replace(/\/$/, '/') + url.slice('ipfs://'.length);
  }
  if (/^(https?:|data:)/.test(url)) return url;
  return null;
}

/**
 * LUKSO beacon (consensus) API — serves EIP-4844 blob sidecars so a reader can
 * recover a blob body by slot: `/eth/v1/beacon/blob_sidecars/{slot}`. Proven
 * live 2026-10-22 (recovered the spike blob by a third party and verified
 * 0x01 ++ sha256(kzg_commitment)[1:] == the on-chain anchored hash). Blobs are
 * pruned after ~18 days, so this is the retrieval path for the blob lane; an
 * older blob returns 404 (body gone, hash still on-chain). Override with
 * VITE_BEACON_URL. Note: the public EL host also answers the beacon API.
 *
 * BROWSER CORS CAVEAT (2026-10-22): the public LUKSO beacon endpoint answers
 * 200 but sends NO `access-control-allow-origin` header, so a browser blocks it
 * (confirmed from the GitHub Pages origin). Blob-BODY recovery for display
 * therefore needs a CORS-enabled beacon/blob node (a blobscan-style API or a
 * small CORS proxy) — set VITE_BEACON_URL to that. POSTING a blob and the LSP25
 * signature test do NOT use the beacon, so they work regardless.
 */
export const BEACON_URL: string =
  (import.meta.env?.VITE_BEACON_URL as string | undefined) ??
  'https://rpc.mainnet.lukso.network';

/**
 * Transport for NEW posts. 'blob' = EIP-4844 blob lane (body ephemeral in a
 * blob, KZG hash anchored on-chain via WallV2.postBlob); 'text' = legacy
 * calldata+event lane (WallV2.post). DEFAULT is 'blob' per product decision
 * (2026-10-22). The UI exposes a toggle; blob posting needs a wallet that signs
 * Type-3 txs — if the UP extension can't (see blob.ts canSignType3), the UI
 * surfaces it and the team implements extension/relay Type-3 support. Reading
 * always handles BOTH lanes regardless of this setting.
 */
export type Transport = 'blob' | 'text';

/**
 * Is the blob lane AVAILABLE as a posting option at all? Gated on a configured
 * blob relayer: without VITE_BLOB_RELAYER_URL there is nothing to carry a blob,
 * so the whole feature is hidden and Text is the only lane. (Reading still
 * handles already-posted blobs regardless — this only governs NEW posts / the
 * UI toggle.) Set VITE_BLOBS_ENABLED=0 to force-hide it even with a relayer.
 */
export const BLOBS_ENABLED: boolean =
  !!(import.meta.env?.VITE_BLOB_RELAYER_URL as string | undefined) &&
  (import.meta.env?.VITE_BLOBS_ENABLED as string | undefined) !== '0';

export const DEFAULT_TRANSPORT: Transport = !BLOBS_ENABLED
  ? 'text'
  : (import.meta.env?.VITE_DEFAULT_TRANSPORT as string | undefined) === 'text'
    ? 'text'
    : 'blob';

/**
 * LSP25 blob RELAYER endpoint (optional). SIGNATURE-first model (relay.ts): the
 * frontend asks the extension to sign the LSP25 `executeRelayCall` digest and
 * hands the relayer ONLY that signature + the request. The relayer recovers the
 * signer, validates it is an authorized LSP6 controller of the UP, meters
 * (DAWG/LSP7), attaches the blob, pays gas, and calls the UP's KeyManager so the
 * UP is msg.sender inside WallV2.postBlob (PostedBlob.from = the UP). The dApp
 * never needs the controller EOA.
 *
 * PROVEN on mainnet (poc/lab-ups/blob-sigrelay-spike.mjs, 2026-10-22): blobhash(0)
 * is read 3 call frames deep, zero WallV2 change, recover-and-validate works.
 *
 * Two endpoints:
 *   GET  {url}/nonce?up=<up>  -> { keyManager, nonce, validityTimestamps? }
 *        (the relayer names the controller + returns its getNonce; the frontend
 *        can't, because the extension abstracts the controller away)
 *   POST {url}/execute        body { up, keyManager, signature, nonce,
 *        validityTimestamps, payload, blob } -> { txHash }
 *        (blob = 0x-hex of the 128 KB field-element-encoded blob)
 *
 * If VITE_BLOB_RELAYER_URL is unset: blob posts still run the SIGNATURE TEST
 * (keyManager read on-chain, nonce 0) and surface what the extension did, but
 * nothing is submitted. Direct Type-3 is used only outside the relay path (works
 * only if the wallet signs Type-3). See docs/BLOB-ARCHITECTURE.md §relay.
 */
export const BLOB_RELAYER_URL: string | null =
  (import.meta.env?.VITE_BLOB_RELAYER_URL as string | undefined) ?? null;

/** LSP25 standard constants (same on every LUKSO KeyManager). */
export const LSP25_VERSION = 25;

/**
 * Wall contract — WallV2, LIVE on LUKSO mainnet (deployed 2026-10-22).
 * Stores public plaintext posts and encrypted DM ciphertext on-chain via the
 * `Posted` event (the frontend reads from logs, not state). v2 dropped the
 * redundant `bodyOf` storage mapping (~73% gas cut) and added forward-compatible
 * `postBlob` EIP-4844 hash-anchor hooks (client blob lane not shipped yet — see
 * docs/BLOB-ARCHITECTURE.md). The `Posted` event signature is unchanged from v1,
 * so WALL_ABI/read+write of text posts is identical.
 * v1 (retired): 0xd3a767c7fE981524810aF7bdE05FA6537B96f58E.
 * Override via VITE_WALL_ADDRESS for a different deploy.
 */
export const WALL_ADDRESS: string =
  (import.meta.env?.VITE_WALL_ADDRESS as string | undefined) ??
  '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';

/** Known lab peers you can DM out of the box. */
export const KNOWN_PEERS: { name: string; address: string }[] = [
  { name: 'alice', address: '0xA02B2b0cB13a87824B0e42C951de3B1a20ECbA5C' },
  { name: 'bob', address: '0xf380f128b69c5EC2dffafC7Dd3f80DFDed0f509C' },
];
