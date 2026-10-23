// Announce.tsx — step 2: publish my X25519 conversation pubkey on-chain.
// Required before I can SEND or RECEIVE encrypted DMs. Public wall posts do not
// need this — so we let the user skip straight to the wall for public posting,
// but encrypted DM compose stays locked until announced.
//
// The conv key comes from a signature by the connected wallet's controller, so
// the same UP via another wallet (UP Mobile vs. the extension) can derive a
// different key. If a different key is already published we never replace it
// by default: peers encrypt to the published key, so replacing it can make
// earlier DMs unreadable for this UP and its contacts.
import { useEffect, useState } from 'react';
import { useApp } from '../state/app';
import { announceConvPub, convPubOf } from '../lib/registry';
import { convPubToBytes32 } from '../lib/up';
import { EXPLORER } from '../lib/config';

export function Announce() {
  const { state, dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [published, setPublished] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const up = state.up!;
  const myConvPub = convPubToBytes32(up.convPub);
  const mismatch = !!published && published.toLowerCase() !== myConvPub.toLowerCase();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const onchain = await convPubOf(up.address);
        if (!live) return;
        if (onchain && onchain.toLowerCase() === myConvPub.toLowerCase()) {
          dispatch({ type: 'announced', up });
        } else {
          setPublished(onchain);
        }
      } catch {
        /* non-fatal */
      } finally {
        if (live) setChecking(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [up.address, myConvPub, dispatch]);

  async function onAnnounce() {
    setBusy(true);
    setErr(null);
    try {
      // Re-check right before writing (the mount check may have failed or be
      // stale): only write over nothing, or over the exact key the warning
      // showed. Anything else is shown first and needs another click. (A key
      // published between this read and the tx landing can't be caught here —
      // the registry's announce() has no expected-key check.)
      const onchain = await convPubOf(up.address);
      if (onchain && onchain.toLowerCase() === myConvPub.toLowerCase()) {
        dispatch({ type: 'announced', up });
        return;
      }
      if (onchain && onchain.toLowerCase() !== published?.toLowerCase()) {
        setPublished(onchain);
        return;
      }
      const hash = await announceConvPub(up.signer, myConvPub);
      setTx(hash);
      dispatch({ type: 'announced', up });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card center">
      <h2>Announce your conversation key</h2>
      <p className="muted">
        One-time onboarding for <b>encrypted DMs</b>. Publishes your X25519
        conversation public key on-chain so peers can derive the shared key and
        decrypt your sealed messages. You sign once in your wallet; nothing is
        stored. You pay a small amount of gas.
      </p>
      <p className="mono small">UP: {up.address}</p>
      <p className="mono small">convPub: {myConvPub}</p>
      {mismatch && (
        <>
          <p className="mono small">published: {published}</p>
          <p className="warn">
            This wallet uses a different messaging key. Replacing your published key
            can prevent you and your contacts from reading earlier DMs. Use your
            original wallet to keep its key.
          </p>
        </>
      )}
      {checking ? (
        <p className="hint">Checking on-chain…</p>
      ) : (
        <button disabled={busy} onClick={onAnnounce}>
          {busy ? 'Announcing…' : mismatch ? 'Replace published key' : 'Announce key'}
        </button>
      )}
      {tx && (
        <p className="hint">
          Announced:{' '}
          <a href={`${EXPLORER}/tx/${tx}`} target="_blank" rel="noreferrer">
            {tx.slice(0, 10)}…
          </a>
        </p>
      )}
      {err && <p className="error">{err}</p>}
      <button className="link" onClick={() => dispatch({ type: 'goWall' })}>
        Skip for now (public posts only) →
      </button>
    </div>
  );
}
