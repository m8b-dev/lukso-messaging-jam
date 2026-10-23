// up.ts — Universal Profile connection via the LUKSO connect modal
// (@lukso/up-modal) + ethers v6.
//
// The modal lets the user pick how to connect their Universal Profile:
//   - UP Browser Extension (discovered via EIP-6963), or
//   - UP Mobile (WalletConnect: QR code on desktop, deep link on mobile).
// EOA wallets are hidden: this app's identity is a UP (profile name/picture,
// registry keys), so we also check the connected account is an LSP0 account.
//
// The modal drives its own wagmi config. Once wagmi reports a connection we
// take that connector's EIP-1193 provider and wrap it in an ethers
// BrowserProvider, so everything downstream (signatures, contract writes)
// stays on ethers. The modal, wagmi and viem are loaded with a dynamic import
// on the first connect click, so the welcome page doesn't pay for them.
//
// The X25519 *conversation* key is derived deterministically from a fixed
// EIP-191 signature (a constant domain string), so it is zero-stored-state.
// The controller private key never leaves the wallet; we only ever ask it to
// sign. The signature comes from the wallet's controller key, though, so the
// same UP connected through a different controller (UP Mobile vs. the
// extension) derives a DIFFERENT conv key — Announce.tsx guards against
// silently replacing the published one.

import { ethers } from 'ethers';
import type { Config, Connector } from '@wagmi/core';
import type { LuksoConnector } from '@lukso/up-modal';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { CHAIN_ID, WALLETCONNECT_PROJECT_ID } from './config';
import { getReadProvider } from './rpc';

const CONV_KEY_DOMAIN =
  'up-p2p: derive my X25519 conversation key v1 (sign once; deterministic, no key leaves this device)';

/** ERC-165 interface id of an LSP0 ERC725Account (a Universal Profile). */
const INTERFACE_ID_LSP0 = '0x24871b3d';

/** How long to wait for wagmi to report the connection after the modal does. */
const CONNECTION_TIMEOUT_MS = 15_000;

/** Upper bound on waiting for wagmi's localStorage restore (it never reports a failed one). */
const HYDRATION_TIMEOUT_MS = 1_500;

export interface UpSession {
  address: string;
  signer: ethers.JsonRpcSigner;
  provider: ethers.BrowserProvider;
  /** raw wallet EIP-1193 provider (for the Type-3 capability probe). */
  eip1193: ethers.Eip1193Provider;
  /** true when connected through WalletConnect (UP Mobile), not the extension. */
  viaWalletConnect: boolean;
  /** wagmi uid of the connector this session was built on. */
  connectorUid: string;
  convPriv: Uint8Array;
  convPub: Uint8Array;
}

/**
 * The one connect attempt in flight. The modal's callbacks are fixed at setup,
 * so they report into this; callbacks outside an attempt are ignored.
 * `accepted` is set synchronously on connect so the modal's own close (which
 * follows a successful connect) can't turn the success into a cancel.
 */
interface Attempt {
  accepted: boolean;
  lastError: string | null;
  resolve: (c: Connector) => void;
  reject: (e: Error) => void;
}

let modalPromise: Promise<LuksoConnector> | null = null;
let attempt: Attempt | null = null;
let pending: Promise<UpSession> | null = null;

function errorText(e: CustomEvent): string | null {
  const err = (e.detail as { error?: unknown } | undefined)?.error;
  if (!err) return null;
  if (err instanceof Error) return err.message;
  return String((err as { message?: unknown }).message ?? err);
}

/** Lazily load and set up the connect modal once; a failed setup can retry. */
function getModal(): Promise<LuksoConnector> {
  if (!modalPromise) {
    modalPromise = import('@lukso/up-modal').then(({ setupLuksoConnector }) =>
      setupLuksoConnector({
        theme: 'dark',
        ...(WALLETCONNECT_PROJECT_ID
          ? { walletConnect: { projectId: WALLETCONNECT_PROJECT_ID } }
          : {}),
        chains: { defaultChainId: CHAIN_ID },
        connectors: { upExtension: true, upMobile: true, eoa: false },
        onConnect: () => {
          const a = attempt;
          if (!a || a.accepted) return;
          a.accepted = true;
          void getModal()
            .then((m) => connectedConnector(m.wagmiConfig))
            .then(a.resolve, a.reject);
        },
        onError: (e) => {
          // The modal stays open on errors (rejected request, wrong chain) so
          // the user can retry; remember why, in case they give up.
          if (attempt && !attempt.accepted) attempt.lastError = errorText(e) ?? attempt.lastError;
        },
        onClose: () => {
          const a = attempt;
          if (!a || a.accepted) return;
          a.reject(new Error(a.lastError ?? 'Connection cancelled.'));
        },
      }),
    ).then(async (modal) => {
      await dropRestoredConnections(modal.wagmiConfig);
      return modal;
    });
    modalPromise.catch(() => {
      modalPromise = null;
    });
  }
  return modalPromise;
}

/**
 * The modal's wagmi config persists connections to localStorage, and on load
 * restores them as stripped {id,name,type,uid} records with no provider. Nothing
 * else revalidates them, so without this they linger next to the live
 * connection and resurface as `current` after a disconnect. Wait for the async
 * restore to land (else it could overwrite us later; bounded, since a corrupt
 * store never reports), then clear them — as wagmi's own hydrate does when not
 * reconnecting. Deliberately NOT reconnect(): that silently connects every
 * authorized wallet, including hidden EOAs, and skips the wallet pick.
 */
async function dropRestoredConnections(config: Config): Promise<void> {
  // zustand's persist API on wagmi's internal store (its type doesn't resolve here).
  const persist = (
    config._internal.store as unknown as {
      persist?: { hasHydrated(): boolean; onFinishHydration(fn: () => void): () => void };
    }
  ).persist;
  if (persist && !persist.hasHydrated()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, HYDRATION_TIMEOUT_MS);
      const off = persist.onFinishHydration(done);
      function done() {
        clearTimeout(timer);
        off?.();
        resolve();
      }
      if (persist.hasHydrated()) done();
    });
  }
  clearConnections(config);
}

function clearConnections(config: Config): void {
  config.setState((x) => ({ ...x, connections: new Map(), current: null, status: 'disconnected' }));
}

const hasProvider = (c: Connector | undefined): c is Connector =>
  typeof (c as { getProvider?: unknown } | undefined)?.getProvider === 'function';

/** The connected wagmi connector, waiting briefly if wagmi lags the modal. */
async function connectedConnector(config: Config): Promise<Connector> {
  const { getConnection, watchConnection } = await import('@wagmi/core');
  const stale = new Error('Stale wallet session. Please connect again.');
  const now = getConnection(config);
  if (now.status === 'connected') {
    if (hasProvider(now.connector)) return now.connector;
    throw stale;
  }
  return new Promise((resolve, reject) => {
    const stop = watchConnection(config, {
      onChange(c) {
        if (c.status !== 'connected') return;
        clearTimeout(timer);
        stop();
        if (hasProvider(c.connector)) resolve(c.connector);
        else reject(stale);
      },
    });
    const timer = setTimeout(() => {
      stop();
      reject(new Error('The wallet connected but no session was reported. Try again.'));
    }, CONNECTION_TIMEOUT_MS);
  });
}

/**
 * Drop every wagmi connection so the next attempt starts from a fresh wallet
 * pick. disconnect() only removes one connection and promotes the next, so
 * disconnect each, then clear whatever is left (e.g. a disconnect that threw).
 */
async function forgetConnection(): Promise<void> {
  const modal = await modalPromise?.catch(() => null);
  if (!modal) return;
  const config = modal.wagmiConfig;
  const { disconnect, getConnections } = await import('@wagmi/core');
  for (const c of getConnections(config)) {
    await disconnect(config, { connector: c.connector }).catch(() => {});
  }
  clearConnections(config);
}

async function isUniversalProfile(address: string): Promise<boolean> {
  const read = await getReadProvider();
  const account = new ethers.Contract(
    address,
    ['function supportsInterface(bytes4) view returns (bool)'],
    read,
  );
  try {
    return Boolean(await account.supportsInterface(INTERFACE_ID_LSP0));
  } catch (e) {
    // revert (no ERC-165) or empty return (no code) → not a UP
    if (ethers.isError(e, 'CALL_EXCEPTION') || ethers.isError(e, 'BAD_DATA')) return false;
    throw new Error('Could not verify your Universal Profile on LUKSO (network error). Please try again.');
  }
}

/** Whether wagmi's connection is still the one `session` was built on. */
function sameSession(
  c: { status: string; chainId?: number; address?: string; connector?: Connector },
  session: { address: string; connectorUid: string },
): boolean {
  return (
    c.status === 'connected' &&
    c.chainId === CHAIN_ID &&
    c.connector?.uid === session.connectorUid &&
    !!c.address &&
    ethers.getAddress(c.address) === session.address
  );
}

async function openAndConnect(): Promise<UpSession> {
  const modal = await getModal();

  // Any failure from here on (cancel, stale session, wrong chain, not a UP,
  // rejected signature) drops the wagmi connections, so the next click offers
  // a fresh wallet pick instead of silently reusing this one.
  try {
    const connector = await new Promise<Connector>((resolve, reject) => {
      attempt = { accepted: false, lastError: null, resolve, reject };
      modal.showSignInModal();
    }).finally(() => {
      attempt = null;
    });

    const eip1193 = (await connector.getProvider()) as ethers.Eip1193Provider;
    const viaWalletConnect = connector.type === 'walletConnect';

    const chainId = Number(await eip1193.request({ method: 'eth_chainId' }));
    if (chainId !== CHAIN_ID) {
      throw new Error(`Switch your wallet to LUKSO mainnet (chain ${CHAIN_ID}) and connect again.`);
    }

    const provider = new ethers.BrowserProvider(eip1193, CHAIN_ID);
    const signer = await provider.getSigner();
    const address = ethers.getAddress(await signer.getAddress());

    if (!(await isUniversalProfile(address))) {
      throw new Error(
        `${address} is not a Universal Profile. Connect with the UP Browser Extension or UP Mobile.`,
      );
    }

    const { convPriv, convPub } = await deriveConvKey(signer);

    // The wallet may have switched account/chain or disconnected while we
    // waited on the signature; watchUpSession only sees later changes.
    const { getConnection } = await import('@wagmi/core');
    if (!sameSession(getConnection(modal.wagmiConfig), { address, connectorUid: connector.uid })) {
      throw new Error('Your wallet changed while signing. Please connect again.');
    }

    return {
      address,
      signer,
      provider,
      eip1193,
      viaWalletConnect,
      connectorUid: connector.uid,
      convPriv,
      convPub,
    };
  } catch (e) {
    await forgetConnection();
    throw e;
  }
}

/**
 * Open the connect modal and resolve with a ready UP session (account checked,
 * conv key derived). Concurrent calls share the one attempt in flight.
 */
export function connectUp(): Promise<UpSession> {
  if (!pending) {
    pending = openAndConnect().finally(() => {
      pending = null;
    });
  }
  return pending;
}

/**
 * Call `onLost` once if the wallet disconnects or switches account or chain
 * away from `session`. Returns an unsubscribe.
 */
export function watchUpSession(session: UpSession, onLost: () => void): () => void {
  let done = false;
  let stop: (() => void) | null = null;
  const check = (c: Parameters<typeof sameSession>[0]) => {
    if (done) return;
    if (c.status === 'connecting' || c.status === 'reconnecting') return;
    if (sameSession(c, session)) return;
    done = true;
    stop?.();
    onLost();
  };
  void (async () => {
    const modal = await modalPromise?.catch(() => null);
    if (!modal || done) return;
    const { getConnection, watchConnection } = await import('@wagmi/core');
    if (done) return;
    stop = watchConnection(modal.wagmiConfig, { onChange: check });
    // watchConnection only reports changes; catch any that landed before it.
    check(getConnection(modal.wagmiConfig));
  })();
  return () => {
    done = true;
    stop?.();
  };
}

/**
 * Deterministic X25519 conv key from a UP signature. We sign a constant string
 * (EIP-191), then HKDF the 65-byte signature into a 32-byte X25519 scalar. The
 * same controller key always yields the same conv key; nothing is stored.
 */
export async function deriveConvKey(
  signer: ethers.Signer,
): Promise<{ convPriv: Uint8Array; convPub: Uint8Array }> {
  const sig = await signer.signMessage(CONV_KEY_DOMAIN);
  const ikm = ethers.getBytes(sig);
  const salt = ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(CONV_KEY_DOMAIN)));
  const convPriv = hkdf(sha256, ikm, salt, new TextEncoder().encode('x25519-conv-v1'), 32);
  return { convPriv, convPub: x25519.getPublicKey(convPriv) };
}

/** bytes32-encode the 32-byte conv pubkey for the registry announce call. */
export function convPubToBytes32(convPub: Uint8Array): string {
  return ethers.hexlify(convPub);
}
