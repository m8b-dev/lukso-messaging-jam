// Wall.tsx — UP Dawg messenger, WhatsApp-style layout.
//
// Shell: a two-pane messenger.
//   * LEFT  (chat list): UpDog logo, a name/address search that autocompletes
//     people to DM via the Envio indexer, section tabs (Chats · Wall · Mentions
//     · Discover) and the persistent conversation list.
//   * RIGHT (thread)   : the selected view. A DM shows a chat header with
//     msg · call · videocall actions (calls disabled — "coming soon"), then the
//     thread + composer. Public / Mentions / Discover render their panes.
//
// Mobile: single-pane swap. The list is shown by default; opening a chat slides
// the thread over the full width with a ‹ back arrow. Driven by `mobilePane`.
//
// Names: everywhere a peer appears we show the LSP3 profile name (names.ts)
// rather than a raw address, falling back to `0xabcd…1234#HASH`.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../state/app';
import {
  watchWall,
  decodePosts,
  postPublic,
  postPublicBlob,
  postDm,
  postDmBlob,
  loadCachedFeed,
  saveCachedFeed,
  type WallPost,
  type RelayCtx,
  type SignOutcome,
} from '../lib/wall';
import { useTransport } from '../lib/transport';
import { convPubOf, announceConvPub } from '../lib/registry';
import { convPubToBytes32 } from '../lib/up';
import { threadIdFor } from '../lib/crypto';
import { resolveName, nameOf, profileOf, upLabel, type ProfileHit } from '../lib/names';
import { watchRoster, type RosterEntry } from '../lib/roster';
import {
  loadConversations,
  saveConversations,
  mergeConversations,
  type Conversation,
} from '../lib/conversations';
import { EXPLORER, ipfsToHttp, BLOBS_ENABLED, RELAYER_CONFIGURED, CREDITS_PANEL_ENABLED } from '../lib/config';
import { SignProgress, type SignPhase } from './SignProgress';
import { CreditsPanel } from './CreditsPanel';
import { ethers } from 'ethers';
import {
  P2pDriver,
  startCall,
  answerCall,
  isInboundSignal,
  type P2pStatus,
} from '../lib/p2p';

type View =
  | { kind: 'public' }
  | { kind: 'thread'; rootId: number }
  | { kind: 'mentions' }
  | { kind: 'people' }
  | { kind: 'credits' }
  | { kind: 'profile'; address: string }
  | { kind: 'dm'; name: string; address: string };

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * UpDog logo — inline SVG wordmark (a dog with a chat-bubble ear). Kept inline
 * so the static bundle needs no asset round-trip. `size` scales it.
 */
function UpDogLogo({ size = 28 }: { size?: number }) {
  return (
    <span className="brand" aria-label="UP Dawg">
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <defs>
          <linearGradient id="udg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff4785" />
            <stop offset="1" stopColor="#8a5cff" />
          </linearGradient>
        </defs>
        {/* chat bubble */}
        <path
          d="M8 10a6 6 0 0 1 6-6h20a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H18l-8 8V32a6 6 0 0 1-2-4.5V10Z"
          fill="url(#udg)"
        />
        {/* dog face */}
        <circle cx="19" cy="17" r="2.2" fill="#0d1117" />
        <circle cx="29" cy="17" r="2.2" fill="#0d1117" />
        <path d="M20 23c1.6 1.6 6.4 1.6 8 0" stroke="#0d1117" strokeWidth="2" strokeLinecap="round" />
        {/* floppy ears */}
        <path d="M10 8c-2 3-2 7 1 9 1-3 1-6-1-9Z" fill="#8a5cff" />
        <path d="M38 8c2 3 2 7-1 9-1-3-1-6 1-9Z" fill="#8a5cff" />
      </svg>
      <span className="brandname">UP&nbsp;Dawg</span>
    </span>
  );
}

/**
 * useProfile — reverse-resolve a UP address to its { name, avatar } (cached +
 * de-duped in names.ts). `avatar` is already gateway-resolved to an http(s)
 * URL an <img> can load (ipfs:// → gateway), or null. Skips the zero address.
 */
function useProfile(address: string | null | undefined): { name: string | null; avatar: string | null } {
  const [info, setInfo] = useState<{ name: string | null; avatar: string | null }>({ name: null, avatar: null });
  useEffect(() => {
    let live = true;
    setInfo({ name: null, avatar: null });
    if (address && address !== ZERO) {
      profileOf(address)
        .then((p) => live && setInfo({ name: p.name, avatar: ipfsToHttp(p.avatar) }))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [address]);
  return info;
}

/**
 * useName — reverse-resolve a UP address to its human-readable `name#HASH`
 * label. Returns '' for the zero address.
 */
function useName(address: string | null | undefined): string {
  const { name } = useProfile(address);
  if (!address || address === ZERO) return '';
  return upLabel(address, name);
}

/**
 * Address label that resolves to @name. When `onProfile` is given it renders a
 * button that opens the in-app profile view; otherwise it links out to the
 * explorer. Falls back to a short address while the name resolves.
 */
function Who({ address, onProfile }: { address: string; onProfile?: (address: string) => void }) {
  const label = useName(address);
  if (onProfile) {
    return (
      <button
        type="button"
        className="wholink"
        onClick={(e) => { e.stopPropagation(); onProfile(address); }}
        title="View this profile on the wall"
      >
        {label || short(address)}
      </button>
    );
  }
  return (
    <a className="mono" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
      {label || short(address)}
    </a>
  );
}

/**
 * Avatar — the real LSP3 profile picture when the indexer has one, else a
 * deterministic monogram (first letter + stable hue from the address). When
 * `onClick` is set the avatar becomes a button that opens the profile view.
 */
function Avatar({
  address,
  label,
  onClick,
  size,
}: {
  address: string;
  label?: string;
  onClick?: (address: string) => void;
  size?: number;
}) {
  const { name, avatar } = useProfile(address);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [avatar]);

  const text = (label || name || address).replace(/^@/, '');
  const ch = text.trim()[0]?.toUpperCase() ?? '?';
  const hue = parseInt(address.slice(2, 8), 16) % 360;
  const dim = size ? { width: size, height: size, fontSize: Math.round(size * 0.42) } : undefined;
  const showImg = avatar && !broken;

  const inner = showImg ? (
    <img
      className="avatarimg"
      src={avatar}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
    />
  ) : (
    ch
  );
  const style = showImg ? dim : { background: `hsl(${hue} 55% 42%)`, ...dim };

  if (onClick) {
    return (
      <button
        type="button"
        className="avatar avatarbtn"
        style={style}
        onClick={(e) => { e.stopPropagation(); onClick(address); }}
        title="View this profile on the wall"
      >
        {inner}
      </button>
    );
  }
  return (
    <span className="avatar" style={style}>
      {inner}
    </span>
  );
}

/**
 * KeyStatus — the brandbar 🔑 affordance. Replaces the old button that
 * dispatched `needAnnounce` → bounced to the Announce screen, which (when you
 * were already announced) re-checked the chain and instantly navigated back,
 * so it just *flashed* for ~0.5s. Now it opens a stable anchored popover you
 * dismiss yourself: it shows your conv-key status + pubkey, with an inline
 * "Announce" action only when you haven't announced yet. No navigation.
 */
function KeyStatus({
  up,
  announced,
  dispatch,
}: {
  up: UpState;
  announced: boolean;
  dispatch: ReturnType<typeof useApp>['dispatch'];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  // A DIFFERENT conv key already on-chain (same UP via another wallet): shown
  // as a warning, and replacing it takes a second, explicit click.
  const [published, setPublished] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const myConvPub = useMemo(() => convPubToBytes32(up!.convPub), [up]);

  // Close on outside-click or Escape — a popover, not a fly-by toast.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  async function announce() {
    setBusy(true);
    setErr(null);
    try {
      // Only write over nothing, or over the exact key the warning showed
      // (same rule as Announce.tsx).
      const onchain = await convPubOf(up!.address);
      if (onchain && onchain.toLowerCase() === myConvPub.toLowerCase()) {
        dispatch({ type: 'announced', up: up! });
        return;
      }
      if (onchain && onchain.toLowerCase() !== published?.toLowerCase()) {
        setPublished(onchain);
        return;
      }
      const hash = await announceConvPub(up!.signer, myConvPub);
      setTx(hash);
      dispatch({ type: 'announced', up: up! });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="keystatus" ref={wrap}>
      <button
        className={`iconbtn${announced ? '' : ' warn'}`}
        title="Conversation key status"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {announced ? '🔑' : '⚠️'}
      </button>
      {open && (
        <div className="keypop" role="dialog" aria-label="Conversation key status">
          <div className="keypop-head">
            <span className={announced ? 'ok' : 'warn'}>
              {announced
                ? '🔑 Key announced'
                : published
                  ? '⚠️ Different key published'
                  : '⚠️ Key not announced'}
            </span>
            <button className="keypop-x" aria-label="Close" onClick={() => setOpen(false)}>×</button>
          </div>
          <p className="small muted">
            {announced
              ? 'Your X25519 conversation key is published on-chain — peers can derive the shared key and decrypt your sealed DMs.'
              : 'Encrypted DMs are locked until you publish your X25519 conversation key on-chain. One signature, a little gas, done once. Public wall posts don’t need it.'}
          </p>
          <div className="keypop-row">
            <span className="muted">conv pubkey</span>
            <span className="mono small">{short(myConvPub)}</span>
          </div>
          {tx && (
            <p className="small">
              Announced:{' '}
              <a href={`${EXPLORER}/tx/${tx}`} target="_blank" rel="noreferrer">{tx.slice(0, 10)}…</a>
            </p>
          )}
          {published && !announced && (
            <p className="warn small">
              This wallet uses a different messaging key. Replacing your published key
              can prevent you and your contacts from reading earlier DMs. Use your
              original wallet to keep its key.
            </p>
          )}
          {err && <p className="error small">{err}</p>}
          {!announced && !tx && (
            <button className="keypop-cta" disabled={busy} onClick={announce}>
              {busy ? 'Announcing…' : published ? 'Replace published key' : 'Announce key'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Wall() {
  const { state, dispatch } = useApp();
  const up = state.up!;

  const myLabel = useName(up.address);
  const [myRawName, setMyRawName] = useState<string>('');
  useEffect(() => {
    let live = true;
    nameOf(up.address).then((n) => live && setMyRawName(n ?? '')).catch(() => {});
    return () => { live = false; };
  }, [up.address]);

  const relay = useMemo<RelayCtx>(
    () => ({ up: up.address, upName: myRawName }),
    [up, myRawName],
  );

  const [raw, setRaw] = useState<WallPost[]>([]);
  const [decoded, setDecoded] = useState<WallPost[]>(() => loadCachedFeed(up.address));
  const [view, setView] = useState<View>({ kind: 'public' });
  // Which pane is showing on NARROW screens. On wide screens both show at once.
  const [mobilePane, setMobilePane] = useState<'list' | 'thread'>('list');
  const [peerAnnounced, setPeerAnnounced] = useState<Record<string, boolean>>({});
  const [roster, setRoster] = useState<RosterEntry[]>([]);

  // persistent conversation list (hydrated synchronously for instant paint)
  const [convs, setConvs] = useState<Conversation[]>(() => loadConversations(up.address));

  // subscribe to the whole wall once
  useEffect(() => {
    let off: (() => void) | undefined;
    watchWall(setRaw).then((unsub) => (off = unsub)).catch(() => {});
    return () => off?.();
  }, []);

  // subscribe to the announced-UP directory once
  useEffect(() => {
    let off: (() => void) | undefined;
    watchRoster(setRoster).then((unsub) => (off = unsub)).catch(() => {});
    return () => off?.();
  }, []);

  // decode whenever raw changes (streaming, newest-first). See blank-wall note.
  const convPriv = up.convPriv;
  useEffect(() => {
    const upsert = (p: WallPost) =>
      setDecoded((prev) => {
        const i = prev.findIndex((x) => x.id === p.id);
        if (i === -1) return [...prev, p].sort((a, b) => a.id - b.id);
        const next = prev.slice();
        next[i] = p;
        return next;
      });
    decodePosts(raw, { addr: up.address, convPriv }, upsert)
      .catch((e) => console.error('[wall] decodePosts failed:', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw, up.address]);

  const meLc = up.address.toLowerCase();

  // merged conversation list (persisted + known peers + decoded threads),
  // newest-first. Reverse-resolution to @name happens per-row in ConvRow.
  const conversations = useMemo(
    () => mergeConversations(up.address, convs, decoded),
    [up.address, convs, decoded],
  );

  // announce status for everyone in the conversation list (DM gating)
  useEffect(() => {
    conversations.forEach(async (c) => {
      const k = c.address.toLowerCase();
      if (k in peerAnnounced) return;
      try {
        const v = await convPubOf(c.address);
        setPeerAnnounced((s) => ({ ...s, [k]: !!v }));
      } catch {
        /* ignore */
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations]);

  // Public feed, newest → oldest.
  const publicFeed = useMemo(
    () => decoded.filter((p) => !p.encrypted).sort((a, b) => b.id - a.id),
    [decoded],
  );
  useEffect(() => {
    if (publicFeed.length) saveCachedFeed(up.address, publicFeed);
  }, [publicFeed, up.address]);

  // Thread structure, derived once per feed change:
  //   byId          — every public post by id (for repost embeds + ancestor walk)
  //   childrenOf    — direct replies to each post id (ascending, oldest-first)
  //   replyCountOf   — total descendants under each post id (for the "N replies" badge)
  //   timeline      — what the Wall tab shows: roots only (plain posts + reposts),
  //                   newest-first. Replies live inside their thread, not the feed.
  const { byId, childrenOf, replyCountOf, timeline } = useMemo(() => {
    const byId = new Map<number, WallPost>();
    for (const p of publicFeed) byId.set(p.id, p);
    const childrenOf = new Map<number, WallPost[]>();
    for (const p of publicFeed) {
      if (p.kind === 'reply' && typeof p.parentId === 'number') {
        const arr = childrenOf.get(p.parentId) ?? [];
        arr.push(p);
        childrenOf.set(p.parentId, arr);
      }
    }
    for (const arr of childrenOf.values()) arr.sort((a, b) => a.id - b.id);
    // total descendants (memoized walk)
    const replyCountOf = new Map<number, number>();
    const countDesc = (id: number): number => {
      if (replyCountOf.has(id)) return replyCountOf.get(id)!;
      let n = 0;
      for (const c of childrenOf.get(id) ?? []) n += 1 + countDesc(c.id);
      replyCountOf.set(id, n);
      return n;
    };
    for (const p of publicFeed) countDesc(p.id);
    // timeline = roots: a post is a root unless it is a reply (replies are nested).
    // Reposts DO appear in the timeline (they re-float content). Newest-first.
    const timeline = publicFeed.filter((p) => p.kind !== 'reply');
    return { byId, childrenOf, replyCountOf, timeline };
  }, [publicFeed]);

  const mentions = useMemo(
    () => publicFeed.filter((p) => p.tag.toLowerCase() === meLc && p.from.toLowerCase() !== meLc),
    [publicFeed, meLc],
  );

  const dmThread = useMemo(() => {
    if (view.kind !== 'dm') return [];
    const tid = threadIdFor(up.address, view.address).toLowerCase();
    const meLc2 = up.address.toLowerCase();
    const peerLc = view.address.toLowerCase();
    return decoded.filter((p) => {
      if (p.signal || p.threadId.toLowerCase() !== tid) return false;
      if (p.encrypted) return true;
      // Unencrypted DM = a PUBLIC post carrying the DM threadId, exchanged
      // between the two parties (tagged at one, authored by the other). It
      // threads into this conversation even though anyone can read it.
      const fromLc = p.from.toLowerCase();
      const tagLc = p.tag.toLowerCase();
      const pair = [meLc2, peerLc];
      return pair.includes(fromLc) && pair.includes(tagLc) && fromLc !== tagLc;
    });
  }, [decoded, view, up.address]);

  /** Open a DM: persist the conversation, select it, and (mobile) show thread. */
  function openDm(name: string, address: string) {
    setConvs((prev) => {
      if (prev.some((c) => c.address.toLowerCase() === address.toLowerCase())) return prev;
      const next = [...prev, { address, name: name || null }];
      saveConversations(up.address, next);
      return next;
    });
    setView({ kind: 'dm', name: name || short(address), address });
    setMobilePane('thread');
  }

  /** Select a non-DM section view (Wall/Mentions/Discover/thread). */
  function openSection(v: View) {
    setView(v);
    setMobilePane('thread');
  }

  /** Open the focused thread view for a post. */
  const openThread = (rootId: number) => openSection({ kind: 'thread', rootId });

  /** Open the profile view for a UP (their posts + mentions of them). */
  const openProfile = (address: string) => openSection({ kind: 'profile', address });

  // Posts + reposts authored BY the focused profile (newest-first, roots + reposts
  // but not bare replies — same shape as the main timeline), plus every public
  // post that @mentions them. Derived only when a profile view is open.
  const profileAddr = view.kind === 'profile' ? view.address.toLowerCase() : null;
  const profilePosts = useMemo(
    () =>
      profileAddr
        ? timeline.filter((p) => p.from.toLowerCase() === profileAddr)
        : [],
    [timeline, profileAddr],
  );
  // A profile's Mentions tab shows EVERY public post that @tagged them —
  // including their own self-tags (unlike the global Mentions tab, which is
  // "who tagged ME" and omits self). That way tagging yourself isn't a dead end.
  const profileMentions = useMemo(
    () =>
      profileAddr
        ? publicFeed.filter((p) => p.tag.toLowerCase() === profileAddr)
        : [],
    [publicFeed, profileAddr],
  );

  const selectedDm = view.kind === 'dm' ? view.address.toLowerCase() : null;

  return (
    <div className={`messenger pane-${mobilePane}`}>
      <aside className="chatlist">
        <header className="brandbar">
          <UpDogLogo />
          <KeyStatus up={up} announced={state.announced} dispatch={dispatch} />
        </header>

        <div className="mecard">
          <Avatar address={up.address} />
          <div className="meid">
            <div className="mename" title={up.address}>{myLabel || short(up.address)}</div>
            <div className="small">
              {state.announced ? (
                <span className="ok">● key announced</span>
              ) : (
                <button className="link" onClick={() => dispatch({ type: 'needAnnounce' })}>
                  announce key →
                </button>
              )}
            </div>
          </div>
          <TransportToggle />
        </div>

        <NewChatSearch openDm={openDm} />

        <nav className="sectiontabs">
          <button className={view.kind === 'public' ? 'stab active' : 'stab'}
            onClick={() => openSection({ kind: 'public' })}>🧱 Wall</button>
          <button className={view.kind === 'mentions' ? 'stab active' : 'stab'}
            onClick={() => openSection({ kind: 'mentions' })}>
            @ Mentions{mentions.length > 0 && <span className="badge">{mentions.length}</span>}
          </button>
          <button className={view.kind === 'people' ? 'stab active' : 'stab'}
            onClick={() => openSection({ kind: 'people' })}>
            🌐 Discover{roster.length > 0 && <span className="badge">{roster.length}</span>}
          </button>
          {CREDITS_PANEL_ENABLED && (
            <button className={view.kind === 'credits' ? 'stab active' : 'stab'}
              onClick={() => openSection({ kind: 'credits' })}>
              🪙 Credits
            </button>
          )}
        </nav>

        <ul className="convlist">
          <li className="convsection small muted">Chats</li>
          {conversations.length === 0 && (
            <li className="muted empty small">No conversations yet. Search above to DM someone.</li>
          )}
          {conversations.map((c) => (
            <ConvRow
              key={c.address}
              conv={c}
              active={selectedDm === c.address.toLowerCase()}
              announced={!!peerAnnounced[c.address.toLowerCase()]}
              onClick={(name) => openDm(name, c.address)}
            />
          ))}
        </ul>
      </aside>

      <section className="threadview">
        {view.kind === 'public' ? (
          <SectionHeader title="🧱 The Wall" subtitle="Everything that happened here — on-chain, newest first"
            onBack={() => setMobilePane('list')} />
        ) : view.kind === 'thread' ? (
          <SectionHeader title="🧵 Thread" subtitle="A post and its replies"
            onBack={() => openSection({ kind: 'public' })} />
        ) : view.kind === 'mentions' ? (
          <SectionHeader title="@ Mentions" subtitle="Public posts that tagged you"
            onBack={() => setMobilePane('list')} />
        ) : view.kind === 'people' ? (
          <SectionHeader title="🌐 Discover" subtitle="Universal Profiles that announced an encryption key"
            onBack={() => setMobilePane('list')} />
        ) : view.kind === 'credits' ? (
          <SectionHeader title="🪙 Credits (test)" subtitle="Soulbound relay-credit token on the dawgtestup service UP"
            onBack={() => setMobilePane('list')} />
        ) : view.kind === 'profile' ? (
          <SectionHeader title="👤 Profile" subtitle="This profile's posts and mentions"
            onBack={() => openSection({ kind: 'public' })} />
        ) : (
          <ChatHeader peer={view} connected={false} onBack={() => setMobilePane('list')} />
        )}

        <div className="threadbody">
          {view.kind === 'public' ? (
            <PublicPane
              me={meLc}
              up={up}
              timeline={timeline}
              byId={byId}
              replyCountOf={replyCountOf}
              relay={relay}
              openThread={openThread}
              openProfile={openProfile}
            />
          ) : view.kind === 'thread' ? (
            <ThreadPane
              me={meLc}
              up={up}
              rootId={view.rootId}
              byId={byId}
              childrenOf={childrenOf}
              replyCountOf={replyCountOf}
              relay={relay}
              openThread={openThread}
              openProfile={openProfile}
            />
          ) : view.kind === 'mentions' ? (
            <MentionsPane me={meLc} feed={mentions} openThread={openThread} openProfile={openProfile} />
          ) : view.kind === 'people' ? (
            <DiscoverPane me={meLc} roster={roster} openDm={openDm} />
          ) : view.kind === 'credits' ? (
            <CreditsPanel up={up} />
          ) : view.kind === 'profile' ? (
            <ProfilePane
              me={meLc}
              address={view.address}
              posts={profilePosts}
              mentions={profileMentions}
              byId={byId}
              replyCountOf={replyCountOf}
              openThread={openThread}
              openProfile={openProfile}
              openDm={openDm}
              isMe={profileAddr === meLc}
            />
          ) : (
            <DmPane
              key={view.address.toLowerCase()}
              up={up}
              peer={view}
              thread={dmThread}
              allPosts={decoded}
              meAnnounced={state.announced}
              peerAnnounced={!!peerAnnounced[view.address.toLowerCase()]}
              relay={relay}
            />
          )}
        </div>
      </section>
    </div>
  );
}

/**
 * ChatHeader — the WhatsApp-style header above a DM thread: back arrow (mobile),
 * avatar + resolved name + announce status, and the msg · call · videocall
 * action row. Audio & video calls are DISABLED ("coming soon"); `msg` is the
 * active mode. `connected` reflects the live P2P channel state (reserved for
 * when calls are enabled; today it only tints the msg button).
 */
function ChatHeader({
  peer,
  connected,
  onBack,
}: {
  peer: { name: string; address: string };
  connected: boolean;
  onBack: () => void;
}) {
  const label = useName(peer.address);
  const display = label || peer.name || short(peer.address);
  return (
    <header className="chathead">
      <button className="backbtn" onClick={onBack} aria-label="Back to chats">‹</button>
      <Avatar address={peer.address} label={peer.name} />
      <div className="chatid">
        <div className="chatname">{display}</div>
        <a className="mono small muted" href={`${EXPLORER}/address/${peer.address}`}
          target="_blank" rel="noreferrer">{short(peer.address)} ↗</a>
      </div>
      <div className="callnav">
        <button className={`navbtn active`} title="Messages">💬</button>
        <button className="navbtn" disabled title="Voice call — coming soon">📞</button>
        <button className="navbtn" disabled title="Video call — coming soon">🎥</button>
      </div>
    </header>
  );
}

/** Header for the non-DM section panes, with a mobile back arrow. */
function SectionHeader({ title, subtitle, onBack }: { title: string; subtitle: string; onBack: () => void }) {
  return (
    <header className="chathead">
      <button className="backbtn" onClick={onBack} aria-label="Back to chats">‹</button>
      <div className="chatid">
        <div className="chatname">{title}</div>
        <div className="small muted">{subtitle}</div>
      </div>
    </header>
  );
}

/**
 * NewChatSearch — the "start a new conversation" box at the top of the chat
 * list. Typing a UP name queries the Envio indexer (names.ts resolveName) and
 * suggests matching profiles to DM; pasting a 0x address jumps straight to it.
 * Picking a hit opens (and persists) a DM conversation.
 */
function NewChatSearch({ openDm }: { openDm: (name: string, address: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ProfileHit[]>([]);
  const [searching, setSearching] = useState(false);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onSearch(v: string) {
    setQ(v);
    if (deb.current) clearTimeout(deb.current);
    if (!v.trim()) {
      setHits([]);
      setSearching(false);
      return;
    }
    if (/^0x[0-9a-fA-F]{40}$/.test(v.trim())) {
      setHits([{ address: ethers.getAddress(v.trim()), name: null, avatar: null }]);
      setSearching(false);
      return;
    }
    setSearching(true);
    deb.current = setTimeout(async () => {
      try {
        setHits(await resolveName(v));
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  function pick(h: ProfileHit) {
    openDm(h.name ?? '', h.address);
    setQ('');
    setHits([]);
  }

  return (
    <div className="newchat">
      <input
        className="searchbox"
        placeholder="🔍  New chat — type a UP @name or paste 0x…"
        value={q}
        onChange={(e) => onSearch(e.target.value)}
      />
      {q.trim() !== '' && (
        <ul className="searchhits">
          {searching && <li className="muted empty small">searching…</li>}
          {!searching && hits.length === 0 && (
            <li className="muted empty small">No profile found for “{q.trim()}”.</li>
          )}
          {hits.map((h) => (
            <li key={h.address}>
              <button className="hitrow" onClick={() => pick(h)}>
                <Avatar address={h.address} label={h.name ?? undefined} />
                <span className="hitid">
                  <span className="hitname">{h.name ? '@' + h.name : short(h.address)}</span>
                  <span className="mono small muted">{short(h.address)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One row in the conversation list: avatar, resolved name, preview, status dot. */
function ConvRow({
  conv,
  active,
  announced,
  onClick,
}: {
  conv: Conversation;
  active: boolean;
  announced: boolean;
  onClick: (name: string) => void;
}) {
  const resolved = useName(conv.address);
  const display = resolved || (conv.name ? upLabel(conv.address, conv.name) : short(conv.address));
  const bare = conv.name ?? (resolved.includes('#') ? resolved.split('#')[0] : '');
  return (
    <li>
      <button className={active ? 'convrow active' : 'convrow'} onClick={() => onClick(bare)}>
        <Avatar address={conv.address} label={conv.name ?? undefined} />
        <span className="convmeta">
          <span className="convtop">
            <span className="convname">{display}</span>
            {conv.ts ? <span className="convts small muted">{fmtShort(conv.ts)}</span> : null}
          </span>
          <span className="convpreview small muted">
            {conv.preview || (announced ? 'Ready — encrypted DM' : 'Tap to open')}
          </span>
        </span>
        <span className={announced ? 'statusdot on' : 'statusdot'} title={announced ? 'announced key' : 'has not announced'} />
      </button>
    </li>
  );
}

/**
 * TransportToggle — pick the lane for NEW posts.
 *   🫧 Blob  = default / cheap / promoted. Body rides an ephemeral EIP-4844
 *              blob (~18 days on the beacon), only its hash is anchored forever.
 *              After that it survives only in your cache or a 3rd-party blob
 *              archive (possibly paywalled, Slack-style). Available when the lane
 *              is enabled (config.BLOBS_ENABLED) — gas-less via a relayer when
 *              one is up, otherwise self-sent by the wallet (user pays gas, needs
 *              Type-3). Hidden only if VITE_BLOBS_ENABLED=0.
 *   📝 Text  = premium / permanent. Body lives in calldata forever — the
 *              unforgettable lane; costs more gas.
 */
function TransportToggle() {
  const { transport, setTransport, type3 } = useTransport();
  const blobBlocked = type3 === 'no';

  // No relayer → blobs are off; Text is the only lane. Nothing to toggle, so
  // show a quiet "permanent" badge instead of a dead single-button segment.
  if (!BLOBS_ENABLED) {
    return (
      <div className="transport small">
        <span className="lane-note" title="Posts live in calldata, permanently on-chain.">
          📝 Permanent posts — on-chain forever
        </span>
      </div>
    );
  }

  return (
    <div className="transport small">
      <div className="seg">
        <button
          className={transport === 'blob' ? 'seg-on' : ''}
          disabled={blobBlocked}
          title={
            RELAYER_CONFIGURED
              ? 'Gas-less via relayer. Body rides an EIP-4844 blob (~18 days), then lives only in your cache or a 3rd-party archive. Just its hash is anchored on-chain.'
              : 'Self-sent by your wallet (you pay gas; needs a Type-3-capable wallet). Body rides an EIP-4844 blob (~18 days); just its hash is anchored on-chain.'
          }
          onClick={() => setTransport('blob')}
        >🫧 Blob · {RELAYER_CONFIGURED ? 'cheap' : 'you pay gas'}</button>
        <button
          className={transport === 'text' ? 'seg-on' : ''}
          title="Premium & permanent. Body lives in calldata forever — the unforgettable lane. Costs more gas."
          onClick={() => setTransport('text')}
        >📝 Text · forever</button>
      </div>
      <div className="muted" style={{ marginTop: 4 }}>
        {blobBlocked
          ? 'Wallet can’t sign blob (Type-3) yet — using Text.'
          : transport === 'blob'
            ? RELAYER_CONFIGURED
              ? '🫧 Gas-less & fleeting — gone in ~18 days unless you (or an archive) keep it.'
              : '🫧 You pay gas (no relayer) & fleeting — gone in ~18 days unless kept.'
            : '📝 Premium & permanent — an unforgettable post, on-chain forever.'}
      </div>
    </div>
  );
}

/** A tiny lane badge so you can see which posts rode a blob. */
function LaneBadge({ p }: { p: WallPost }) {
  if (p.lane !== 'blob') return null;
  return (
    <span className="lane-badge small muted" title="posted via EIP-4844 blob (body ephemeral, hash on-chain)">
      🫧 blob
    </span>
  );
}

/** Render a post body, handling an expired (pruned) blob body + locked DMs. */
function Body({ p }: { p: WallPost }) {
  if (p.pruned) {
    return <em className="muted">🫧 blob body expired — only its on-chain hash remains</em>;
  }
  if (p.locked) return <em className="muted">🔒 encrypted — cannot decrypt</em>;
  return <>{p.text}</>;
}

type UpState = ReturnType<typeof useApp>['state']['up'];

/**
 * PublicPane — the Wall timeline. Composer is pinned at the TOP (this is a
 * broadcast feed, not a chat), then the feed of roots (plain posts + reposts),
 * newest-first. Replies are nested inside threads, not shown flat here; each
 * post surfaces a "N replies" affordance that opens the focused thread.
 */
function PublicPane({
  me,
  up,
  timeline,
  byId,
  replyCountOf,
  relay,
  openThread,
  openProfile,
}: {
  me: string;
  up: UpState;
  timeline: WallPost[];
  byId: Map<number, WallPost>;
  replyCountOf: Map<number, number>;
  relay: RelayCtx;
  openThread: (id: number) => void;
  openProfile: (address: string) => void;
}) {
  // Optimistic "reposted by me" set so the 🔁 fills instantly (chain confirms later).
  const [reposted, setReposted] = useState<Set<number>>(new Set());
  const { transport } = useTransport();

  async function repost(p: WallPost) {
    setReposted((s) => new Set(s).add(p.id));
    try {
      if (transport === 'blob') {
        await postPublicBlob(up!.signer, '', { kind: 'repost', parent: p.id }, relay);
      } else {
        await postPublic(up!.signer, '', { kind: 'repost', parent: p.id });
      }
    } catch {
      setReposted((s) => { const n = new Set(s); n.delete(p.id); return n; });
    }
  }

  return (
    <>
      <Composer
        up={up}
        relay={relay}
        placeholder="What's happening on-chain?"
        cta="Post to the wall"
        allowTag
      />

      <ul className="feed">
        {timeline.length === 0 && (
          <li className="muted empty">The wall is quiet. Post the first thing that happens here.</li>
        )}
        {timeline.map((p) => (
          <FeedItem
            key={p.id}
            post={p}
            me={me}
            byId={byId}
            replies={replyCountOf.get(p.id) ?? 0}
            reposted={reposted.has(p.id)}
            onOpenThread={() => openThread(p.id)}
            onReply={() => openThread(p.id)}
            onRepost={() => repost(p)}
            openProfile={openProfile}
          />
        ))}
      </ul>
    </>
  );
}

/**
 * FeedItem — one timeline entry. A plain post renders as a card; a repost
 * renders a "🔁 reposted" banner wrapping the embedded original. Both expose
 * the reply / repost / open-thread actions.
 */
function FeedItem({
  post,
  me,
  byId,
  replies,
  reposted,
  onOpenThread,
  onReply,
  onRepost,
  openProfile,
}: {
  post: WallPost;
  me: string;
  byId: Map<number, WallPost>;
  replies: number;
  reposted: boolean;
  onOpenThread: () => void;
  onReply: () => void;
  onRepost: () => void;
  openProfile?: (address: string) => void;
}) {
  if (post.kind === 'repost') {
    const original = typeof post.parentId === 'number' ? byId.get(post.parentId) : undefined;
    return (
      <li className="feeditem">
        <div className="repostbanner small muted">🔁 <Who address={post.from} onProfile={openProfile} /> reposted · {fmtShort(post.timestamp)}</div>
        {original ? (
          <PostCard post={original} me={me} replies={replies} reposted={reposted}
            onOpenThread={onOpenThread} onReply={onReply} onRepost={onRepost}
            onFocusClick={onOpenThread} openProfile={openProfile} embedded />
        ) : (
          <div className="post ghost small muted">🫧 original post unavailable (body expired or not yet loaded)</div>
        )}
      </li>
    );
  }
  return (
    <li className="feeditem">
      <PostCard post={post} me={me} replies={replies} reposted={reposted}
        onOpenThread={onOpenThread} onReply={onReply} onRepost={onRepost}
        onFocusClick={onOpenThread} openProfile={openProfile} />
    </li>
  );
}

/**
 * PostCard — the redesigned wall card: avatar + identity line, timestamp,
 * optional @mention chip, body, and an action bar (reply · repost · on-chain).
 * `embedded` drops the outer margin when nested inside a repost / thread.
 */
function PostCard({
  post,
  me,
  replies,
  reposted,
  onOpenThread,
  onReply,
  onRepost,
  embedded,
  dim,
  onFocusClick,
  openProfile,
}: {
  post: WallPost;
  me: string;
  replies: number;
  reposted: boolean;
  onOpenThread: () => void;
  onReply: () => void;
  onRepost: () => void;
  embedded?: boolean;
  dim?: boolean;
  /** click the card BODY (not the action bar) to focus this post in a thread. */
  onFocusClick?: () => void;
  /** open the profile view for an author / tagged UP. */
  openProfile?: (address: string) => void;
}) {
  const mine = post.from.toLowerCase() === me;
  const cls = ['post', mine ? 'mine' : '', embedded ? 'embedded' : '', dim ? 'dim' : '',
    onFocusClick ? 'clickable' : ''].filter(Boolean).join(' ');
  return (
    <article className={cls}>
      <div className="postmain" onClick={onFocusClick} role={onFocusClick ? 'button' : undefined}>
        <Avatar address={post.from} onClick={openProfile} />
        <div className="postcol">
          <div className="posthead">
            <span className="postwho"><Who address={post.from} onProfile={openProfile} /></span>
            {post.tag !== ZERO && (
              <span className={post.tag.toLowerCase() === me ? 'tagged tagme' : 'tagged'}>→ <Tag address={post.tag} onProfile={openProfile} /></span>
            )}
            <span className="ts" title={fmt(post.timestamp)}>{fmtShort(post.timestamp)}</span>
            <LaneBadge p={post} />
          </div>
          <div className="body"><Body p={post} /></div>
        </div>
      </div>
      <div className="actionbar small" onClick={(e) => e.stopPropagation()}>
        <button className="act" onClick={onReply} title="Reply">💬 {replies > 0 ? replies : 'Reply'}</button>
        <button className={reposted ? 'act on' : 'act'} onClick={onRepost} title="Repost">🔁 {reposted ? 'Reposted' : 'Repost'}</button>
        {replies > 0 && <button className="act" onClick={onOpenThread} title="Open thread">🧵 Thread</button>}
        <a className="act" href={`${EXPLORER}/tx/${post.txHash}`} target="_blank" rel="noreferrer" title="View on-chain">⛓ On-chain ↗</a>
      </div>
    </article>
  );
}

/**
 * Composer — the shared post box. Used at the top of the Wall (plain posts, with
 * an optional @tag) and at the bottom of a thread (replies, `kind:'reply'` with
 * a `parent`). `onPosted` lets the thread view refocus / clear.
 */
function Composer({
  up,
  relay,
  placeholder,
  cta,
  allowTag,
  parent,
  kind,
  compact,
}: {
  up: UpState;
  relay: RelayCtx;
  placeholder: string;
  cta: string;
  allowTag?: boolean;
  parent?: number;
  kind?: 'post' | 'reply';
  compact?: boolean;
}) {
  const [text, setText] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [hits, setHits] = useState<ProfileHit[]>([]);
  const [tag, setTag] = useState<{ label: string; address: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sig, setSig] = useState<SignOutcome | null>(null);
  const [phase, setPhase] = useState<SignPhase>('idle');
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { transport } = useTransport();

  function onTag(v: string) {
    setTagInput(v);
    setTag(null);
    if (deb.current) clearTimeout(deb.current);
    if (!v.trim()) return setHits([]);
    if (/^0x[0-9a-fA-F]{40}$/.test(v.trim())) {
      setTag({ label: short(v.trim()), address: v.trim() });
      setHits([]);
      return;
    }
    deb.current = setTimeout(async () => {
      try {
        setHits(await resolveName(v));
      } catch {
        setHits([]);
      }
    }, 300);
  }

  async function send() {
    setBusy(true);
    setErr(null);
    setSig(null);
    if (doneTimer.current) clearTimeout(doneTimer.current);
    // Blob posts narrate their phases via the dawg spinner; plain text lands
    // fast enough that a spinner would just flicker.
    const blob = transport === 'blob';
    setPhase(blob ? 'signing' : 'idle');
    try {
      const opts = { tag: tag?.address ?? null, kind: kind ?? 'post', parent } as const;
      if (blob) {
        await postPublicBlob(up!.signer, text.trim(), opts, {
          ...relay,
          // onSign fires the instant the extension signs — now we're just
          // waiting on the relayer + mining.
          onSign: (o) => { setSig(o); if (o.ok) setPhase('relaying'); },
        });
        setPhase('done');
        doneTimer.current = setTimeout(() => setPhase('idle'), 4000);
      } else {
        await postPublic(up!.signer, text.trim(), opts);
      }
      setText('');
      setTagInput('');
      setTag(null);
      setHits([]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase(blob ? 'error' : 'idle');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={compact ? 'composer compact' : 'composer top'}>
      <textarea
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={1024}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() && !busy) {
            e.preventDefault();
            send();
          }
        }}
      />
      {allowTag && (
        <>
          <div className="tagrow">
            <input
              placeholder="🏷 mention a UP (optional): @name or 0x…"
              value={tagInput}
              onChange={(e) => onTag(e.target.value)}
            />
            {tag && <span className="pill">@{tag.label} <button className="link" onClick={() => { setTag(null); setTagInput(''); }}>×</button></span>}
          </div>
          {tag && tag.address.toLowerCase() === up!.address.toLowerCase() && (
            <p className="taghint small muted">
              👋 That’s you — tagging yourself won’t ping you (your Mentions skip
              your own posts), but it will show on your profile’s Mentions tab.
            </p>
          )}
          {hits.length > 0 && (
            <ul className="hits">
              {hits.map((h) => (
                <li key={h.address}>
                  <button className="link" onClick={() => { setTag({ label: h.name ?? short(h.address), address: h.address }); setHits([]); setTagInput(h.name ?? h.address); }}>
                    {h.name ? '@' + h.name : short(h.address)} — {short(h.address)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="composerfoot">
        <span className="small muted">⌘/Ctrl+Enter to post · on-chain, public forever</span>
        <button disabled={busy || !text.trim()} onClick={send}>
          {busy ? 'Posting…' : cta}
        </button>
      </div>
      {err && phase === 'idle' && <p className="error small">{err}</p>}
      <SignProgress phase={phase} outcome={sig} error={err} />
    </div>
  );
}

/**
 * ThreadPane — the focused X-style thread view. Walks ancestors up from the
 * focused post (so you see what it replied to), shows the focused post, then its
 * descendants FLAT in chronological order (each tappable to refocus). A reply
 * composer at the bottom targets the focused post.
 */
function ThreadPane({
  me,
  up,
  rootId,
  byId,
  childrenOf,
  replyCountOf,
  relay,
  openThread,
  openProfile,
}: {
  me: string;
  up: UpState;
  rootId: number;
  byId: Map<number, WallPost>;
  childrenOf: Map<number, WallPost[]>;
  replyCountOf: Map<number, number>;
  relay: RelayCtx;
  openThread: (id: number) => void;
  openProfile: (address: string) => void;
}) {
  const focused = byId.get(rootId);

  // ancestor chain (oldest → the focused post's parent), walking parentId up.
  const ancestors: WallPost[] = [];
  {
    let cur = focused;
    const seen = new Set<number>();
    while (cur && typeof cur.parentId === 'number' && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const par = byId.get(cur.parentId);
      if (!par) break;
      ancestors.unshift(par);
      cur = par;
    }
  }

  // flat descendants in chronological order (depth-first, ids ascending).
  const descendants: WallPost[] = [];
  const walk = (id: number) => {
    for (const c of childrenOf.get(id) ?? []) {
      descendants.push(c);
      walk(c.id);
    }
  };
  if (focused) walk(focused.id);

  if (!focused) {
    return <div className="muted empty">This post isn’t loaded yet — pull to refresh or go back to the wall.</div>;
  }

  return (
    <>
      <ul className="feed thread">
        {ancestors.map((a) => (
          <li className="feeditem ancestor" key={a.id}>
            <PostCard post={a} me={me} replies={replyCountOf.get(a.id) ?? 0} reposted={false}
              onOpenThread={() => openThread(a.id)} onReply={() => openThread(a.id)} onRepost={() => {}}
              onFocusClick={() => openThread(a.id)} openProfile={openProfile} embedded dim />
          </li>
        ))}

        <li className="feeditem focused" key={focused.id}>
          <PostCard post={focused} me={me} replies={replyCountOf.get(focused.id) ?? 0} reposted={false}
            onOpenThread={() => {}} onReply={() => {}} onRepost={() => {}} openProfile={openProfile} />
        </li>

        <li className="convsection small muted">
          {descendants.length > 0 ? `${descendants.length} ${descendants.length === 1 ? 'reply' : 'replies'}` : 'No replies yet'}
        </li>

        {descendants.map((d) => (
          <li className="feeditem reply" key={d.id}>
            <PostCard post={d} me={me} replies={replyCountOf.get(d.id) ?? 0} reposted={false}
              onOpenThread={() => openThread(d.id)} onReply={() => openThread(d.id)} onRepost={() => {}}
              onFocusClick={() => openThread(d.id)} openProfile={openProfile} embedded />
          </li>
        ))}
      </ul>

      <Composer
        up={up}
        relay={relay}
        placeholder="Write a reply…"
        cta="Reply"
        parent={focused.id}
        kind="reply"
      />
    </>
  );
}

/** Inline @tag label that resolves to @name; opens the profile when clickable. */
function Tag({ address, onProfile }: { address: string; onProfile?: (address: string) => void }) {
  const label = useName(address);
  const text = label || short(address);
  if (onProfile) {
    return (
      <button type="button" className="wholink" onClick={(e) => { e.stopPropagation(); onProfile(address); }}
        title="View this profile on the wall">{text}</button>
    );
  }
  return <>{text}</>;
}

/** MentionsPane — every public post that @tags the connected UP, newest first. */
function MentionsPane({ me, feed, openThread, openProfile }: { me: string; feed: WallPost[]; openThread: (id: number) => void; openProfile: (address: string) => void }) {
  return (
    <ul className="feed">
      {feed.length === 0 && (
        <li className="muted empty">No one has mentioned you yet. When a public post @tags your UP, it shows up here.</li>
      )}
      {feed.map((p) => (
        <li key={p.id} className="feeditem">
          <PostCard post={p} me={me} replies={0} reposted={false}
            onOpenThread={() => openThread(p.id)} onReply={() => openThread(p.id)} onRepost={() => {}}
            onFocusClick={() => openThread(p.id)} openProfile={openProfile} />
        </li>
      ))}
    </ul>
  );
}

/**
 * ProfilePane — a focused view of one UP: a header (big avatar, @name, address,
 * explorer + DM links) and the wall FILTERED to that person — a Posts tab (their
 * posts + reposts) and a Mentions tab (public posts that @tagged them). Opened by
 * clicking any avatar / name / @tag anywhere in the feed.
 */
function ProfilePane({
  me,
  address,
  posts,
  mentions,
  byId,
  replyCountOf,
  openThread,
  openProfile,
  openDm,
  isMe,
}: {
  me: string;
  address: string;
  posts: WallPost[];
  mentions: WallPost[];
  byId: Map<number, WallPost>;
  replyCountOf: Map<number, number>;
  openThread: (id: number) => void;
  openProfile: (address: string) => void;
  openDm: (name: string, address: string) => void;
  isMe: boolean;
}) {
  const { name } = useProfile(address);
  const [tab, setTab] = useState<'posts' | 'mentions'>('posts');
  const label = upLabel(address, name);
  const dmName = name ?? short(address);
  const feed = tab === 'posts' ? posts : mentions;

  return (
    <>
      <div className="profilehead">
        <Avatar address={address} size={72} />
        <div className="profileid">
          <div className="profilename">{label}</div>
          <a className="mono small muted" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
            {short(address)} ↗
          </a>
          <div className="profilestats small muted">
            {posts.length} {posts.length === 1 ? 'post' : 'posts'} · {mentions.length} {mentions.length === 1 ? 'mention' : 'mentions'} on the wall
          </div>
        </div>
        {!isMe && (
          <button className="btn small" onClick={() => openDm(dmName, address)}>🔒 Message</button>
        )}
      </div>

      <nav className="sectiontabs profiletabs">
        <button className={tab === 'posts' ? 'stab active' : 'stab'} onClick={() => setTab('posts')}>
          🧱 Posts{posts.length > 0 && <span className="badge">{posts.length}</span>}
        </button>
        <button className={tab === 'mentions' ? 'stab active' : 'stab'} onClick={() => setTab('mentions')}>
          @ Mentions{mentions.length > 0 && <span className="badge">{mentions.length}</span>}
        </button>
      </nav>

      <ul className="feed">
        {feed.length === 0 && (
          <li className="muted empty">
            {tab === 'posts'
              ? 'No posts from this profile on the wall yet.'
              : 'No one has mentioned this profile on the wall yet.'}
          </li>
        )}
        {feed.map((p) =>
          tab === 'posts' ? (
            <FeedItem
              key={p.id}
              post={p}
              me={me}
              byId={byId}
              replies={replyCountOf.get(p.id) ?? 0}
              reposted={false}
              onOpenThread={() => openThread(p.id)}
              onReply={() => openThread(p.id)}
              onRepost={() => {}}
              openProfile={openProfile}
            />
          ) : (
            <li key={p.id} className="feeditem">
              <PostCard post={p} me={me} replies={replyCountOf.get(p.id) ?? 0} reposted={false}
                onOpenThread={() => openThread(p.id)} onReply={() => openThread(p.id)} onRepost={() => {}}
                onFocusClick={() => openThread(p.id)} openProfile={openProfile} />
            </li>
          ),
        )}
      </ul>
    </>
  );
}

/**
 * DiscoverPane — the public directory of UPs that announced a conversation key.
 * Anyone here is reachable for an encrypted DM. Name shown prominently; address
 * + convPub secondary. Includes a free-text @name/address search.
 */
function DiscoverPane({
  me,
  roster,
  openDm,
}: {
  me: string;
  roster: RosterEntry[];
  openDm: (name: string, address: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ProfileHit[]>([]);
  const [searching, setSearching] = useState(false);
  const deb = useRef<ReturnType<typeof setTimeout> | null>(null);

  function onSearch(v: string) {
    setQ(v);
    if (deb.current) clearTimeout(deb.current);
    if (!v.trim()) return setHits([]);
    if (/^0x[0-9a-fA-F]{40}$/.test(v.trim())) {
      setHits([{ address: v.trim(), name: null, avatar: null }]);
      return;
    }
    setSearching(true);
    deb.current = setTimeout(async () => {
      try {
        setHits(await resolveName(v));
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  const others = roster.filter((r) => r.address.toLowerCase() !== me);

  return (
    <>
      <div className="composer">
        <div className="small muted">
          🌐 Discover — Universal Profiles that announced an encryption key. {others.length} announced.
        </div>
        <input
          className="input"
          placeholder="Search any @name or paste a 0x UP address…"
          value={q}
          onChange={(e) => onSearch(e.target.value)}
        />
        {q.trim() !== '' && (
          <ul className="roster">
            {searching && <li className="muted empty">searching…</li>}
            {!searching && hits.length === 0 && (
              <li className="muted empty">No profile found for “{q}”.</li>
            )}
            {hits.map((h) => (
              <RosterCard key={h.address} address={h.address} presetName={h.name} convPub={null} openDm={openDm} />
            ))}
          </ul>
        )}
      </div>

      <ul className="roster">
        {others.length === 0 && (
          <li className="muted empty">
            No announced profiles in range yet. Once a UP announces its key it appears here —
            or search above to DM anyone directly.
          </li>
        )}
        {others.map((r) => (
          <RosterCard key={r.address} address={r.address} presetName={null} convPub={r.convPub} openDm={openDm} />
        ))}
      </ul>
    </>
  );
}

/** One profile row in the Discover directory / search results. */
function RosterCard({
  address,
  presetName,
  convPub,
  openDm,
}: {
  address: string;
  presetName: string | null;
  convPub: string | null;
  openDm: (name: string, address: string) => void;
}) {
  const resolved = useName(address);
  const name = presetName ? `@${presetName}` : resolved;
  const display = name || short(address);
  const dmName = (presetName ?? (name.startsWith('@') ? name.slice(1) : '')) || short(address);

  return (
    <li className="rostercard">
      <Avatar address={address} label={presetName ?? undefined} />
      <div className="rosterid">
        <span className="rostername">{display}</span>
        <a className="mono small muted" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
          {short(address)} ↗
        </a>
        {convPub && (
          <span className="mono small muted" title={`announced conv pubkey: ${convPub}`}>🔑 {short(convPub)}</span>
        )}
      </div>
      <button className="btn small" onClick={() => openDm(dmName, address)}>🔒 Message</button>
    </li>
  );
}

function DmPane({
  up,
  peer,
  thread,
  allPosts,
  meAnnounced,
  peerAnnounced,
  relay,
}: {
  up: ReturnType<typeof useApp>['state']['up'];
  peer: { name: string; address: string };
  thread: WallPost[];
  allPosts: WallPost[];
  meAnnounced: boolean;
  peerAnnounced: boolean;
  relay: RelayCtx;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sig, setSig] = useState<SignOutcome | null>(null);
  const [phase, setPhase] = useState<SignPhase>('idle');
  const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-message privacy: true = sealed (end-to-end, as before); false = an
  // unencrypted DM, a PUBLIC post tagged to the peer + carrying the DM threadId.
  // Unencrypted needs no key handshake, so it's allowed even when `ready` is false.
  const [encrypt, setEncrypt] = useState(true);
  const ready = meAnnounced && peerAnnounced;
  const { transport } = useTransport();
  const peerLabel = useName(peer.address) || peer.name;

  // Encrypted send is gated on the key handshake; unencrypted never is.
  const canSend = encrypt ? ready : true;

  async function send() {
    setBusy(true);
    setErr(null);
    setSig(null);
    if (doneTimer.current) clearTimeout(doneTimer.current);
    const blob = transport === 'blob';
    setPhase(blob ? 'signing' : 'idle');
    const onSign = (o: SignOutcome) => { setSig(o); if (o.ok) setPhase('relaying'); };
    try {
      if (encrypt) {
        const dmArgs = {
          signer: up!.signer,
          myAddr: up!.address,
          myConvPriv: up!.convPriv,
          peerAddr: peer.address,
          text: text.trim(),
        };
        if (blob) await postDmBlob({ ...dmArgs, relay: { ...relay, onSign } });
        else await postDm(dmArgs);
      } else {
        // Unencrypted DM: a public post, tagged at the peer, carrying the DM
        // threadId so it threads into this conversation. Publicly readable.
        const opts = {
          tag: peer.address,
          threadId: threadIdFor(up!.address, peer.address),
        };
        if (blob)
          await postPublicBlob(up!.signer, text.trim(), opts, { ...relay, onSign });
        else await postPublic(up!.signer, text.trim(), opts);
      }
      setText('');
      if (blob) {
        setPhase('done');
        doneTimer.current = setTimeout(() => setPhase('idle'), 4000);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase(blob ? 'error' : 'idle');
    } finally {
      setBusy(false);
    }
  }

  const meLc = up!.address.toLowerCase();

  return (
    <>
      {!ready && (
        <div className="lockbanner small">
          🔒 Encrypted DM is locked until both parties announce their conversation key.
          {!meAnnounced && ' Announce yours from the top-left.'}
          {!peerAnnounced && ` ${peer.name} must connect and announce too.`}
          {' '}Or switch the composer to 🌐 Public to message them now — readable by
          anyone, but no key handshake needed.
        </div>
      )}

      <P2pPanel up={up} peer={peer} allPosts={allPosts} ready={ready} />

      <ul className="bubbles">
        {thread.length === 0 && <li className="muted empty">No messages yet. Say hi 👋</li>}
        {[...thread].reverse().map((p) => {
          const mine = p.from.toLowerCase() === meLc;
          const open = !p.encrypted; // an unencrypted DM — publicly readable
          return (
            <li key={p.id} className={`bubble${mine ? ' mine' : ''}${open ? ' open' : ''}`}>
              <div className="bubbletext"><Body p={p} /></div>
              <div className="bubblemeta small muted">
                {open ? '🌐 public · ' : ''}{fmt(p.timestamp)} · <a href={`${EXPLORER}/tx/${p.txHash}`} target="_blank" rel="noreferrer">on-chain ↗</a>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="composer dmcomposer">
        <div className="dmlock small">
          <button
            type="button"
            className={`lockpill${encrypt ? ' on' : ''}`}
            aria-pressed={encrypt}
            onClick={() => setEncrypt((v) => !v)}
            title={encrypt ? 'Encrypted — only the two of you can read it' : 'Unencrypted — anyone can read this'}
          >
            {encrypt ? '🔒 Encrypted' : '🌐 Public'}
          </button>
          <span className="muted">
            {encrypt
              ? 'Only you two can read it — still, don’t put real secrets on a public chain.'
              : 'Anyone can read this — but no key needed, and it still threads here.'}
          </span>
        </div>
        <textarea
          placeholder={
            canSend
              ? encrypt
                ? `Encrypted message to ${peerLabel}…`
                : `Public message to ${peerLabel} (anyone can read)…`
              : 'Encrypted is locked until both keys announced — or switch to 🌐 Public'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={!canSend}
          maxLength={800}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && canSend && text.trim() && !busy) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button disabled={!canSend || busy || !text.trim()} onClick={send}>
          {busy ? (encrypt ? 'Sealing…' : 'Posting…') : encrypt ? '🔒 Send' : '🌐 Send'}
        </button>
        {err && phase === 'idle' && <p className="error">{err}</p>}
        <SignProgress phase={phase} outcome={sig} error={err} />
      </div>
    </>
  );
}

/** P2pPanel — the off-chain channel, bootstrapped over the encrypted DM. */
function P2pPanel({
  up,
  peer,
  allPosts,
  ready,
}: {
  up: ReturnType<typeof useApp>['state']['up'];
  peer: { name: string; address: string };
  allPosts: WallPost[];
  ready: boolean;
}) {
  const [status, setStatus] = useState<P2pStatus>('idle');
  const [fp, setFp] = useState<string | null>(null);
  const [log, setLog] = useState<{ me: boolean; text: string }[]>([]);
  const [input, setInput] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const driverRef = useRef<P2pDriver | null>(null);
  const consumed = useRef<Set<number>>(new Set());

  const common = useMemo(
    () => ({
      signer: up!.signer,
      myAddr: up!.address,
      myConvPriv: up!.convPriv,
      peerAddr: peer.address,
      cb: {
        onStatus: setStatus,
        onMessage: (t: string) => setLog((l) => [...l, { me: false, text: t }]),
        onVerified: (f: string) => setFp(f),
      },
    }),
    [up, peer.address],
  );

  useEffect(() => {
    driverRef.current?.hangup();
    driverRef.current = null;
    consumed.current = new Set();
    setStatus('idle');
    setFp(null);
    setLog([]);
    setErr(null);
  }, [peer.address]);

  useEffect(() => {
    const inbound = allPosts.filter((p) => isInboundSignal(p, up!.address, peer.address));
    for (const p of inbound) {
      if (consumed.current.has(p.id)) continue;
      consumed.current.add(p.id);
      const body = ethers.getBytes(p.bodyRaw);
      (async () => {
        try {
          if (!driverRef.current) {
            driverRef.current = await answerCall(common, body);
          } else {
            await driverRef.current.ingest(body);
          }
        } catch (e) {
          setErr(e instanceof Error ? e.message : String(e));
        }
      })();
    }
  }, [allPosts, common, peer.address, up]);

  async function call() {
    setErr(null);
    try {
      driverRef.current = await startCall(common);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  function hangup() {
    driverRef.current?.hangup();
    driverRef.current = null;
  }

  function sendDirect() {
    const t = input.trim();
    if (!t || !driverRef.current) return;
    if (driverRef.current.send(t)) {
      setLog((l) => [...l, { me: true, text: t }]);
      setInput('');
    }
  }

  const connected = status === 'connected';
  const active = status !== 'idle' && status !== 'closed' && status !== 'failed';

  return (
    <div className="p2p">
      <div className="p2phead">
        <span className="small muted">
          🛡️ Tunneled — ultra-secure, direct peer-to-peer (WebRTC, bootstrapped
          via this encrypted DM). Call, video &amp; chat privately off-chain;
          nothing is recorded and there’s no gas cost while the tunnel is up.
        </span>
        <span className={`p2pstatus ${status}`}>{statusLabel(status)}</span>
        {!active ? (
          <button className="link" disabled={!ready} onClick={call} title={ready ? 'Open a private, off-chain, zero-cost tunnel' : 'both keys must be announced first'}>
            Open tunnel →
          </button>
        ) : (
          <button className="link" onClick={hangup}>Hang up</button>
        )}
      </div>
      {fp && (
        <div className="small mono muted" title="UP-signed DTLS fingerprint, pinned">
          🔐 peer DTLS fp verified: {fp.slice(0, 24)}…
        </div>
      )}
      {err && <p className="error small">{err}</p>}
      {connected && (
        <div className="p2pchat">
          <ul className="p2plog">
            {log.length === 0 && <li className="muted small">Tunnel open — messages below are direct P2P, off-chain, zero cost.</li>}
            {log.map((m, i) => (
              <li key={i} className={m.me ? 'p2pmsg mine' : 'p2pmsg'}>
                <span className="mono small">{m.me ? 'you' : peer.name}:</span> {m.text}
              </li>
            ))}
          </ul>
          <div className="p2pcompose">
            <input
              placeholder={`Direct message to ${peer.name} (off-chain)…`}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendDirect()}
            />
            <button onClick={sendDirect} disabled={!input.trim()}>Send ⚡</button>
          </div>
        </div>
      )}
    </div>
  );
}

function statusLabel(s: P2pStatus): string {
  switch (s) {
    case 'idle': return 'not connected';
    case 'calling': return 'calling… (offer sent)';
    case 'ringing': return 'answering…';
    case 'connecting': return 'connecting (ICE)…';
    case 'connected': return '● connected (P2P)';
    case 'failed': return 'failed';
    case 'closed': return 'closed';
  }
}

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
function fmt(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleString();
}
/** Compact timestamp for the conversation list (time today, else date). */
function fmtShort(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
