// wall.ts — on-chain Wall contract: public posts + encrypted DMs.
//
// Public post : plaintext body, optional @tag (mention), threadId = 0.
// DM post     : ciphertext sealed to the shared X25519 conv key of (me, peer),
//               tag = peer, threadId = keccak(sortedPair(me, peer)).
//
// Reading: we queryFilter the Posted event over a moving window (same reason as
// signaling.ts — public RPCs drop eth_newFilter subscriptions). Public bodies
// decode as UTF-8; encrypted bodies decode only if they belong to a thread we
// can derive the key for (i.e. a DM in which we are a participant AND the other
// side has announced its conv pubkey).

import { ethers } from 'ethers';
import { WALL_ADDRESS, CHAIN_ID } from './config';
import { getReadProvider } from './rpc';
import { encodeBlob, blobTxFields, versionedHashFor, fetchBlobBody } from './blob';
import {
  conversationKey,
  threadIdFor,
  sealBytes,
  openBytes,
  dec,
  enc,
  ub,
} from './crypto';
import { convPubOf } from './registry';
import {
  relayerConfigured,
  buildBlobRelayRequest,
  buildAuthMessage,
  sendViaRelayer,
  isControllerOf,
  type SignOutcome,
} from './relay';

export type { SignOutcome } from './relay';

/**
 * Optional relay context. When present AND a relayer is configured, blob posts
 * go through the AUTHOR-SIGNATURE gas-less path (Option B): the extension
 * personal_signs a canonical message binding the post to the UP; the relayer
 * recovers the signer, verifies it is an LSP6 controller of the UP, and posts
 * the blob AS ITSELF with the author proof embedded in `meta`. On-chain
 * PostedBlob.from = the relayer; the authoritative author = `up` (verified from
 * meta on read). The frontend never needs the controller address. See relay.ts.
 */
export interface RelayCtx {
  /** the user's UP address (the authoritative author recorded in meta). */
  up: string;
  /** the user's LSP3 profile name, embedded in meta for display (optional). */
  upName?: string;
  /**
   * Optional diagnostic hook — receives exactly what the extension did when
   * asked to sign the canonical author message (signature bytes / recovered
   * address / rejection). Used by the UI signature panel.
   */
  onSign?: (outcome: SignOutcome) => void;
}

/** Thrown when the extension could not produce the author signature; carries
 *  the diagnostic so the UI can show precisely what happened. */
export class RelaySignError extends Error {
  outcome: SignOutcome;
  constructor(outcome: SignOutcome) {
    super(outcome.error ? `extension could not sign: ${outcome.error}` : 'extension did not sign');
    this.name = 'RelaySignError';
    this.outcome = outcome;
  }
}

// ---- author-proof meta (Option B) -----------------------------------------
// Binary meta packed by the relayer (see blob-relayer-server.mjs packMeta):
//   v(1=2) | scheme(1=1) | up(20) | nonce u64 BE(8) |
//   sigLen(1) | sig(sigLen) | nameLen(1) | name(utf8)
const META_V2 = 2;
const META_SCHEME_AUTHSIG = 1;

export interface AuthMeta {
  up: string;
  nonce: string;
  sig: string;
  name: string;
}

/** Parse the binary author-proof meta; null if it isn't the v2 authsig scheme. */
export function unpackAuthMeta(metaHex: string | undefined): AuthMeta | null {
  if (!metaHex || metaHex === '0x') return null;
  try {
    const b = ethers.getBytes(metaHex);
    if (b.length < 2 + 20 + 8 + 1 || b[0] !== META_V2 || b[1] !== META_SCHEME_AUTHSIG) return null;
    let o = 2;
    const up = ethers.getAddress(ethers.hexlify(b.slice(o, o + 20))); o += 20;
    let nonce = 0n;
    for (let i = 0; i < 8; i++) nonce = (nonce << 8n) | BigInt(b[o + i]); o += 8;
    const sigLen = b[o]; o += 1;
    if (o + sigLen > b.length) return null;
    const sig = ethers.hexlify(b.slice(o, o + sigLen)); o += sigLen;
    const nameLen = o < b.length ? b[o] : 0; o += 1;
    const name = nameLen && o + nameLen <= b.length ? dec.decode(b.slice(o, o + nameLen)) : '';
    return { up, nonce: nonce.toString(), sig, name };
  } catch {
    return null;
  }
}

export const WALL_ABI = [
  'function post(address tag, bool encrypted, bytes32 threadId, bytes body) external',
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'function count() view returns (uint256)',
  'event Posted(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes body)',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
] as const;

export type Lane = 'text' | 'blob';

/**
 * A public post can be a plain post, a reply to another post, or a repost
 * (boost) of another post. Threads/reposts are PUBLIC-only; DMs never carry an
 * envelope. See the PostEnvelope docs below for how this is stamped on-chain.
 */
export type PostKind = 'post' | 'reply' | 'repost';

export interface WallPost {
  id: number;
  from: string;
  tag: string; // 0x000..0 = broadcast
  encrypted: boolean;
  threadId: string;
  timestamp: number;
  lane: Lane;
  txHash: string;
  // TEXT lane: body is in the event. BLOB lane: body rode in the blob (NOT
  // on-chain); bodyRaw is '0x' until the decoder fetches it from the beacon.
  bodyRaw: string; // hex bytes (text: from event; blob: recovered from beacon)
  blobHash?: string; // blob lane: the anchored KZG versioned hash
  metaRaw?: string; // blob lane: tiny framing bytes from the event
  authorName?: string; // blob lane (relayed): LSP3 name carried in author proof
  authorVerified?: boolean; // blob lane (relayed): author signature verified → `from` is the UP
  // filled in by the decoder:
  text?: string; // decoded plaintext, or decrypted DM text
  locked?: boolean; // encrypted and we cannot decrypt
  pruned?: boolean; // blob lane: body no longer retrievable (sidecar pruned)
  signal?: boolean; // P2P WebRTC signaling envelope — not a human message
  // thread / repost (public posts only; decoded from the typed body envelope):
  kind?: PostKind; // 'post' when absent/legacy
  parentId?: number; // reply target (kind:'reply') or reposted post (kind:'repost')
}

// ---- typed body envelope (public threads + reposts) -----------------------
// A public post body is EITHER legacy plain UTF-8 text (every post before this
// feature) OR a typed envelope: a 4-byte magic prefix "\x00UD1" followed by a
// compact JSON record. The leading NUL byte can never start valid chat text, so
// the decoder distinguishes the two cheaply and legacy posts render untouched.
//
//   legacy:   <utf8 text>
//   envelope: 00 55 44 31  {"v":1,"kind":"reply","parent":42,"body":"…"}
//
// The envelope rides in the SAME body bytes on both lanes (text + blob), so no
// contract/relayer/beacon change is needed — only the body we encode/decode.
const ENVELOPE_MAGIC = new Uint8Array([0x00, 0x55, 0x44, 0x31]); // \x00UD1

export interface PostEnvelope {
  v: 1;
  kind: PostKind;
  parent?: number; // parent WallPost.id (reply target / reposted post)
  body?: string; // post text; empty/absent for a plain repost (boost)
}

/** Encode a public body. Plain posts stay legacy (bare UTF-8) for max
 *  back-compat + smallest payload; replies/reposts get the typed envelope. */
export function encodePublicBody(text: string, kind: PostKind, parent?: number): Uint8Array {
  if (kind === 'post') return enc.encode(text); // legacy wire format, unchanged
  const env: PostEnvelope = { v: 1, kind, ...(parent !== undefined ? { parent } : {}), ...(text ? { body: text } : {}) };
  const json = enc.encode(JSON.stringify(env));
  const out = new Uint8Array(ENVELOPE_MAGIC.length + json.length);
  out.set(ENVELOPE_MAGIC, 0);
  out.set(json, ENVELOPE_MAGIC.length);
  return out;
}

/** Decode a public body's bytes into {kind,parentId,text}. Bare text → a plain
 *  post. Only the 4-byte magic triggers JSON parsing. */
export function decodePublicBody(bytes: Uint8Array): { kind: PostKind; parentId?: number; text: string } {
  const hasMagic =
    bytes.length >= ENVELOPE_MAGIC.length &&
    ENVELOPE_MAGIC.every((b, i) => bytes[i] === b);
  if (!hasMagic) return { kind: 'post', text: safeUtf8Bytes(bytes) };
  try {
    const env = JSON.parse(dec.decode(bytes.slice(ENVELOPE_MAGIC.length))) as PostEnvelope;
    const kind: PostKind = env.kind === 'reply' || env.kind === 'repost' ? env.kind : 'post';
    return {
      kind,
      parentId: typeof env.parent === 'number' ? env.parent : undefined,
      text: typeof env.body === 'string' ? env.body : '',
    };
  } catch {
    // Malformed envelope — degrade to showing the raw bytes as a plain post.
    return { kind: 'post', text: safeUtf8Bytes(bytes) };
  }
}

const ZERO = '0x0000000000000000000000000000000000000000';

/** ASCII "p2p1:" — the P2P signaling prefix (kept in sync with p2p.ts P2P_MAGIC). */
const P2P_MAGIC_HEX = '70327031';

/** Cheap check (no decrypt): is this encrypted body a P2P signaling envelope? */
function looksLikeP2pSignal(bodyRaw: string): boolean {
  return bodyRaw.replace(/^0x/, '').toLowerCase().startsWith(P2P_MAGIC_HEX);
}

export function readWall(provider: ethers.Provider): ethers.Contract {
  return new ethers.Contract(WALL_ADDRESS, WALL_ABI, provider);
}
export function writeWall(signer: ethers.Signer): ethers.Contract {
  return new ethers.Contract(WALL_ADDRESS, WALL_ABI, signer);
}

/** A public post can be a plain post, a reply, or a repost. The envelope is
 *  carried in the body; `parent` is the target post's id. */
export interface PublicOpts {
  tag?: string | null;
  kind?: PostKind;
  parent?: number;
  /**
   * On-chain threadId. Defaults to ZeroHash (a normal wall post). An
   * UNENCRYPTED DM sets this to threadIdFor(me, peer) (and `tag` to the peer)
   * so the post — though publicly readable — threads into that DM conversation
   * with no key handshake. Reading it is identical to any other public post.
   */
  threadId?: string;
}

/** Post a PUBLIC message (plain / reply / repost), optionally tagging a UP. */
export async function postPublic(
  signer: ethers.Signer,
  text: string,
  opts?: PublicOpts | string | null,
): Promise<string> {
  const o = normalizePublicOpts(opts);
  const wall = writeWall(signer);
  const body = encodePublicBody(text, o.kind ?? 'post', o.parent);
  const tx = await wall.post(o.tag ?? ZERO, false, o.threadId ?? ethers.ZeroHash, body);
  await tx.wait();
  return tx.hash;
}

/** Back-compat shim: older callers passed a bare `tag` string as the 3rd arg. */
function normalizePublicOpts(opts?: PublicOpts | string | null): PublicOpts {
  if (opts == null) return {};
  if (typeof opts === 'string') return { tag: opts };
  return opts;
}

/**
 * Post an ENCRYPTED DM to `peer`. Requires my conv priv key and the peer's
 * announced conv pub (read from RegistryV3). Seals the plaintext to the shared
 * key; only the two of us can open it.
 */
export async function postDm(args: {
  signer: ethers.Signer;
  myAddr: string;
  myConvPriv: Uint8Array;
  peerAddr: string;
  /** plaintext to seal, OR … */
  text?: string;
  /** … already-sealed bytes to send verbatim (used by P2P signaling, p2p.ts). */
  rawBody?: Uint8Array;
}): Promise<string> {
  const threadId = threadIdFor(args.myAddr, args.peerAddr);
  let body: Uint8Array;
  if (args.rawBody) {
    body = args.rawBody;
  } else {
    const peerPubHex = await convPubOf(args.peerAddr);
    if (!peerPubHex) throw new Error('peer has not announced a conversation key yet');
    const key = conversationKey(args.myConvPriv, ub(peerPubHex), threadId);
    body = await sealBytes(enc.encode(args.text ?? ''), key);
  }
  const wall = writeWall(args.signer);
  const tx = await wall.post(args.peerAddr, true, threadId, body);
  await tx.wait();
  return tx.hash;
}

// ---- BLOB lane senders ----------------------------------------------------
// Same (tag, encrypted, threadId, body) semantics as the text senders, but the
// body rides in an EIP-4844 blob (ephemeral) and only its KZG versioned hash is
// anchored on-chain via postBlob. Requires a wallet that signs Type-3 txs — if
// the signer/provider refuses type:3, sendTransaction rejects and the caller
// (UI) surfaces it. `meta` carries tiny framing only (never the body).

const IFACE = new ethers.Interface(WALL_ABI);

/**
 * Build + send a postBlob carrying `body` in a blob. Two paths:
 *
 * AUTO submit mode (relay if up, else self-send):
 *
 *  1. RELAY (when a RelayCtx is given, the signer exposes a provider, AND a
 *     relayer is configured): ask the extension to sign the author message, POST
 *     it to the relayer, return the real tx hash (PostedBlob.from = the UP,
 *     gas-less; proven on mainnet, blob-sigrelay-spike.mjs). The SignOutcome is
 *     surfaced via `relay.onSign`.
 *
 *  2. SELF-SEND / DIRECT (no relayer, or no RelayCtx): the signer sends the
 *     Type-3 tx itself and pays gas (PostedBlob.from = the signer/UP). Only works
 *     if the wallet signs Type-3. We still fire `relay.onSign` with a self-send
 *     outcome so the spinner narrates it. If the wallet can't do Type-3,
 *     sendTransaction rejects and the UI surfaces it.
 */
async function sendBlobPost(
  signer: ethers.Signer,
  tag: string,
  encrypted: boolean,
  threadId: string,
  body: Uint8Array,
  relay?: RelayCtx | null,
): Promise<string> {
  const blob = encodeBlob(body);
  const blobHash = await versionedHashFor(blob);

  // Path 1: author-signature gas-less relay (Option B). Only when a relayer is
  // actually configured. The relayer builds the on-chain `meta` (author proof);
  // the frontend signs the canonical message and the relayer submits + pays gas.
  if (relay && relayerConfigured() && 'provider' in signer && signer.provider) {
    const signerAddress = await signer.getAddress();
    const { req, outcome } = await buildBlobRelayRequest({
      signer: signer as ethers.JsonRpcSigner,
      signerAddress,
      up: relay.up,
      upName: relay.upName ?? '',
      tag,
      encrypted,
      threadId,
      blobHash,
      len: body.length,
      blobHex: ethers.hexlify(blob),
    });
    relay.onSign?.(outcome);
    if (!req) throw new RelaySignError(outcome);
    return sendViaRelayer(req);
  }

  // Path 2: SELF-SEND — direct Type-3 from the signer (no relayer configured, or
  // no RelayCtx). PostedBlob.from = the signer (the UP itself), so no author
  // proof is needed; meta carries tiny framing. The user pays gas. Narrate the
  // self-send via onSign so the spinner behaves like the relay path.
  const selfAddr = await signer.getAddress();
  relay?.onSign?.({
    ok: true,
    method: 'self-send',
    signer: selfAddr,
    recovered: selfAddr,
    message: 'direct Type-3 self-send (user pays gas, no relayer)',
  });
  const meta = enc.encode(JSON.stringify({ v: 1, len: body.length }));
  const data = IFACE.encodeFunctionData('postBlob', [
    tag,
    encrypted,
    threadId,
    blobHash,
    meta,
  ]);
  const fields = await blobTxFields(blob);
  const tx = await signer.sendTransaction({
    to: WALL_ADDRESS,
    data,
    ...fields,
  });
  await tx.wait();
  return tx.hash;
}

/** Post a PUBLIC message (plain / reply / repost) via the blob lane. */
export async function postPublicBlob(
  signer: ethers.Signer,
  text: string,
  opts?: PublicOpts | string | null,
  relay?: RelayCtx | null,
): Promise<string> {
  const o = normalizePublicOpts(opts);
  const body = encodePublicBody(text, o.kind ?? 'post', o.parent);
  return sendBlobPost(signer, o.tag ?? ZERO, false, o.threadId ?? ethers.ZeroHash, body, relay);
}

/** Post an ENCRYPTED DM to `peer` via the blob lane. Seals exactly like postDm. */
export async function postDmBlob(args: {
  signer: ethers.Signer;
  myAddr: string;
  myConvPriv: Uint8Array;
  peerAddr: string;
  text?: string;
  rawBody?: Uint8Array;
  relay?: RelayCtx | null;
}): Promise<string> {
  const threadId = threadIdFor(args.myAddr, args.peerAddr);
  let body: Uint8Array;
  if (args.rawBody) {
    body = args.rawBody;
  } else {
    const peerPubHex = await convPubOf(args.peerAddr);
    if (!peerPubHex) throw new Error('peer has not announced a conversation key yet');
    const key = conversationKey(args.myConvPriv, ub(peerPubHex), threadId);
    body = await sealBytes(enc.encode(args.text ?? ''), key);
  }
  return sendBlobPost(args.signer, args.peerAddr, true, threadId, body, args.relay);
}

// Recovered blob bodies, cached by post id. A blob's body is immutable (its id
// and anchored hash never change), so once recovered we never refetch it. The
// in-memory map is the hot cache; it is also persisted to localStorage so a
// page reload is INSTANT (no re-fetching every sidecar from the beacon). Value
// is the decoded payload, or `null` once confirmed pruned/missing.
const blobBodyCache = new Map<number, Uint8Array | null>();

const BODY_LS_KEY = 'updawg.blobBodies.v1';
let lsLoaded = false;

/** Seed the in-memory cache from localStorage once (hex-encoded payloads). */
function loadPersistedBodies(): void {
  if (lsLoaded) return;
  lsLoaded = true;
  try {
    const raw = localStorage.getItem(BODY_LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, string | null>;
    for (const [id, hex] of Object.entries(obj)) {
      blobBodyCache.set(Number(id), hex === null ? null : ethers.getBytes(hex));
    }
  } catch {
    /* corrupt cache — ignore, it will rebuild from the beacon */
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Debounced write-back of the whole body cache to localStorage. */
function persistBodies(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      const obj: Record<string, string | null> = {};
      for (const [id, body] of blobBodyCache) {
        obj[id] = body === null ? null : ethers.hexlify(body);
      }
      localStorage.setItem(BODY_LS_KEY, JSON.stringify(obj));
    } catch {
      /* quota / unavailable — the in-memory cache still works this session */
    }
  }, 400);
}

/**
 * Decode a SINGLE post from my vantage point. Pure given the caches; recovers
 * the blob body (cached), resolves the author proof, and decrypts DMs I can
 * open. Returns the display-ready post.
 */
async function decodeOne(
  base: WallPost,
  me: { addr: string; convPriv: Uint8Array } | null,
  readProvider: ethers.Provider,
  getPub: (addr: string) => Promise<Uint8Array | null>,
): Promise<WallPost> {
  let p = base;
  if (p.lane === 'blob') {
    if (!p.blobHash) return { ...p, pruned: true };

    let payload: Uint8Array | null;
    if (blobBodyCache.has(p.id)) {
      payload = blobBodyCache.get(p.id)!;
    } else {
      const got = await fetchBlobBody(readProvider, p.txHash, p.blobHash);
      if (!got.ok || !got.payload) {
        // Cache a definitive pruned/mismatch as null; do NOT cache a transient
        // 'error' (let it retry next pass).
        if (got.reason === 'pruned' || got.reason === 'mismatch') {
          blobBodyCache.set(p.id, null);
          persistBodies();
        }
        return { ...p, pruned: got.reason === 'pruned' || got.reason === 'mismatch' };
      }
      payload = got.payload;
      blobBodyCache.set(p.id, payload);
      persistBodies();
    }
    if (!payload) return { ...p, pruned: true };
    p = { ...p, bodyRaw: ethers.hexlify(payload) };

    // Author resolution (Option B): recover the signer from meta, re-verify it
    // controls meta.up; on success author = meta.up. See header docs.
    const am = unpackAuthMeta(p.metaRaw);
    if (am) {
      try {
        const message = buildAuthMessage({
          chainId: CHAIN_ID,
          wall: WALL_ADDRESS,
          up: am.up,
          tag: p.tag,
          encrypted: p.encrypted,
          threadId: p.threadId,
          blobHash: p.blobHash,
          len: payload.length,
          nonce: am.nonce,
        });
        const recovered = ethers.verifyMessage(message, am.sig);
        const ok = await isControllerOf(readProvider, am.up, recovered).catch(() => false);
        p = { ...p, from: ok ? am.up : p.from, authorName: ok ? am.name : undefined, authorVerified: ok };
      } catch {
        /* leave p.from as the on-chain relayer address */
      }
    }
  }

  if (!p.encrypted) {
    const { kind, parentId, text } = decodePublicBody(ethers.getBytes(p.bodyRaw));
    return { ...p, kind, parentId, text };
  }
  // P2P signaling envelope — not a human chat line.
  if (looksLikeP2pSignal(p.bodyRaw)) return { ...p, signal: true };
  // encrypted: can I open it? Only if I'm a participant and know the peer pub.
  if (me) {
    const meLc = me.addr.toLowerCase();
    const isMine = p.from.toLowerCase() === meLc || p.tag.toLowerCase() === meLc;
    if (isMine) {
      const peer = p.from.toLowerCase() === meLc ? p.tag : p.from;
      const peerPub = await getPub(peer);
      if (peerPub) {
        try {
          const threadId = threadIdFor(me.addr, peer);
          const key = conversationKey(me.convPriv, peerPub, threadId);
          const pt = await openBytes(ethers.getBytes(p.bodyRaw), key);
          return { ...p, text: dec.decode(pt) };
        } catch {
          /* fall through to locked */
        }
      }
    }
  }
  return { ...p, locked: true };
}

/**
 * Decode a batch of posts for display. Streams results as each post decodes:
 * `onPost(decoded)` fires per post (so the UI can render them one-by-one instead
 * of waiting for the whole feed), and the full ordered array is also returned.
 *
 * Posts are decoded NEWEST-FIRST so the most recent content appears first, and
 * cached/persisted bodies make reloads and re-runs near-instant.
 */
export async function decodePosts(
  posts: WallPost[],
  me: { addr: string; convPriv: Uint8Array } | null,
  onPost?: (p: WallPost) => void,
): Promise<WallPost[]> {
  loadPersistedBodies();

  // cache peer convPub lookups for this batch
  const pubCache = new Map<string, Uint8Array | null>();
  const getPub = async (addr: string): Promise<Uint8Array | null> => {
    const k = addr.toLowerCase();
    if (pubCache.has(k)) return pubCache.get(k)!;
    let v: Uint8Array | null = null;
    try {
      const hex = await convPubOf(addr);
      v = hex ? ub(hex) : null;
    } catch {
      v = null;
    }
    pubCache.set(k, v);
    return v;
  };

  const readProvider = await getReadProvider();

  // Newest-first: decode high ids first so the latest posts surface immediately.
  const ordered = [...posts].sort((a, b) => b.id - a.id);
  const byId = new Map<number, WallPost>();
  for (const base of ordered) {
    const d = await decodeOne(base, me, readProvider, getPub);
    byId.set(d.id, d);
    onPost?.(d);
  }
  // Return in ascending id order (the caller/UI sorts for display as it likes).
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function safeUtf8Bytes(bytes: Uint8Array): string {
  try {
    return dec.decode(bytes);
  } catch {
    return '(unreadable bytes)';
  }
}

/**
 * Load recent posts and subscribe to new ones via a moving-window poller.
 * Calls `onPosts(all)` with the full ordered list each time it grows.
 */
export async function watchWall(
  onPosts: (posts: WallPost[]) => void,
  opts: { pollMs?: number; lookbackBlocks?: number } = {},
): Promise<() => void> {
  const provider = await getReadProvider();
  const wall = readWall(provider);
  const pollMs = opts.pollMs ?? 5000;
  const lookback = opts.lookbackBlocks ?? 90_000; // ~ a few days of history on LUKSO

  const byId = new Map<number, WallPost>();
  let stopped = false;
  const head = await provider.getBlockNumber();
  let from = Math.max(0, head - lookback);

  const ingestText = (log: ethers.EventLog) => {
    const a = log.args;
    if (!a) return;
    const id = Number(a.id);
    if (byId.has(id)) return;
    byId.set(id, {
      id,
      from: ethers.getAddress(a.from),
      tag: ethers.getAddress(a.tag),
      encrypted: Boolean(a.encrypted),
      threadId: a.threadId,
      timestamp: Number(a.timestamp),
      lane: 'text',
      bodyRaw: a.body,
      txHash: log.transactionHash,
    });
  };

  const ingestBlob = (log: ethers.EventLog) => {
    const a = log.args;
    if (!a) return;
    const id = Number(a.id);
    if (byId.has(id)) return;
    byId.set(id, {
      id,
      from: ethers.getAddress(a.from),
      tag: ethers.getAddress(a.tag),
      encrypted: Boolean(a.encrypted),
      threadId: a.threadId,
      timestamp: Number(a.timestamp),
      lane: 'blob',
      bodyRaw: '0x', // recovered from the beacon by decodePosts
      blobHash: a.blobHash,
      metaRaw: a.meta,
      txHash: log.transactionHash,
    });
  };

  const emit = () => {
    const all = [...byId.values()].sort((x, y) => x.id - y.id);
    onPosts(all);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const to = await provider.getBlockNumber();
      if (to >= from) {
        // Chunk to stay within RPC getLogs range limits. LUKSO public RPCs
        // (thirdweb, mainnet.lukso.network) cap eth_getLogs at 1000 blocks per
        // request, so the inclusive window lo..hi must span at most 1000 blocks.
        const STEP = 1000;
        const before = byId.size;
        for (let lo = from; lo <= to; lo += STEP) {
          const hi = Math.min(lo + STEP - 1, to);
          const [textLogs, blobLogs] = await Promise.all([
            wall.queryFilter(wall.filters.Posted(), lo, hi) as Promise<ethers.EventLog[]>,
            wall.queryFilter(wall.filters.PostedBlob(), lo, hi) as Promise<ethers.EventLog[]>,
          ]);
          for (const l of textLogs) ingestText(l);
          for (const l of blobLogs) ingestBlob(l);
        }
        from = to + 1;
        // Only emit when the post set actually GREW. The window advances every
        // tick (a new block is mined every few seconds on LUKSO), so emitting
        // unconditionally handed the UI a fresh `raw` array ~every 5s even with
        // no new posts — each change re-ran decodePosts, whose cleanup cancelled
        // the in-flight pass before it finished. A full feed decode (one beacon
        // fetch per blob) takes longer than the poll interval, so it NEVER
        // completed → the wall stayed blank. Emit on growth only. (Fix 2026-10-22.)
        if (byId.size > before) emit();
      }
    } catch (e) {
      // transient RPC hiccup — retry next tick, keep window. Surface it so a
      // persistent getLogs failure isn't silently swallowed.
      console.warn('[watchWall] poll failed, retrying:', (e as Error)?.message ?? e);
    }
    if (!stopped) timer = setTimeout(tick, pollMs);
  };

  let timer: ReturnType<typeof setTimeout> = setTimeout(tick, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------
// Decoded-feed persistence
//
// The slow part of a reload is NOT the beacon — it is the ~90k-block
// queryFilter scan watchWall does to rediscover posts, which only emits once
// it finishes. To make re-entering the dApp instant we snapshot the fully
// DECODED feed to localStorage (per wall+UP), hydrate it synchronously on
// mount, and let the background poller extend/refine it. WallPost is entirely
// JSON-serializable (ids/numbers/bools + hex strings), and posts are
// append-only + immutable once decoded, so a stale snapshot is always a safe
// prefix of the truth. Decrypted DM text is NOT persisted — only the public
// feed is cached (callers pass already-public posts).
const FEED_LS_PREFIX = 'updawg.feed.v1';

function feedKey(up: string): string {
  return `${FEED_LS_PREFIX}:${WALL_ADDRESS.toLowerCase()}:${up.toLowerCase()}`;
}

/** Read the cached decoded feed for this UP (newest-first). Empty on miss. */
export function loadCachedFeed(up: string): WallPost[] {
  try {
    const raw = localStorage.getItem(feedKey(up));
    if (!raw) return [];
    const arr = JSON.parse(raw) as WallPost[];
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => p && typeof p.id === 'number');
  } catch {
    return [];
  }
}

/** Snapshot the decoded feed for this UP. Caller passes display-ready posts. */
export function saveCachedFeed(up: string, posts: WallPost[]): void {
  try {
    localStorage.setItem(feedKey(up), JSON.stringify(posts));
  } catch {
    /* quota / unavailable — in-memory feed still works this session */
  }
}
