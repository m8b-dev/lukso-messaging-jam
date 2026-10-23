// Connect.tsx — step 1: connect any Universal Profile via the LUKSO connect
// modal (UP Browser Extension or UP Mobile).
//
// The welcome page: the UP Dawg mascot (a dog's head poking out of a hot-dog
// bun, riding a weiner, mid-boogie), a sharp/funny pitch, a "What's UP, Dawg?"
// explainer, and the connect button. All inline SVG — no asset round-trip.
import { useState } from 'react';
import { useApp } from '../state/app';
import { connectUp } from '../lib/up';
import { initType3Probe } from '../lib/transport';
import { BLOBS_ENABLED } from '../lib/config';

/**
 * DancingDawg — the mascot: a weiner in a bun with a dog's head popping out of
 * the top, little arms thrown up mid-dance. A CSS wiggle (see styles.css
 * `@keyframes dawg-dance`) makes it boogie; `prefers-reduced-motion` stops it.
 */
function DancingDawg({ size = 132 }: { size?: number }) {
  return (
    <div className="dawg-stage" aria-hidden="true">
      <svg className="dawg" width={size} height={size} viewBox="0 0 120 120" fill="none">
        <defs>
          <linearGradient id="bun" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f6c177" />
            <stop offset="1" stopColor="#e09e4b" />
          </linearGradient>
          <linearGradient id="weiner" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ff7a7a" />
            <stop offset="1" stopColor="#d64b4b" />
          </linearGradient>
          <linearGradient id="fur" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#caa06a" />
            <stop offset="1" stopColor="#a97d44" />
          </linearGradient>
        </defs>

        {/* little dancing legs */}
        <g className="dawg-legs" stroke="#2a2a2a" strokeWidth="4" strokeLinecap="round">
          <path d="M50 104 L42 116" />
          <path d="M70 104 L80 115" />
        </g>

        {/* the hot-dog: bun bottom, weiner, bun top */}
        <rect x="26" y="92" width="68" height="16" rx="8" fill="url(#bun)" />
        <rect x="30" y="80" width="60" height="18" rx="9" fill="url(#weiner)" />
        {/* squiggle of mustard */}
        <path d="M34 86 q8 -7 16 0 q8 7 16 0 q8 -7 14 0" stroke="#ffd93b" strokeWidth="3" fill="none" strokeLinecap="round" />
        <rect x="26" y="74" width="68" height="14" rx="7" fill="url(#bun)" />

        {/* arms thrown up, dancing */}
        <g stroke="url(#fur)" strokeWidth="7" strokeLinecap="round">
          <path className="dawg-arm-l" d="M38 70 L24 54" />
          <path className="dawg-arm-r" d="M82 70 L96 52" />
        </g>

        {/* dog head popping out of the bun */}
        <g className="dawg-head">
          {/* floppy ears */}
          <path d="M34 36 q-10 2 -8 20 q10 -2 10 -16 Z" fill="#8a5c34" />
          <path d="M86 36 q10 2 8 20 q-10 -2 -10 -16 Z" fill="#8a5c34" />
          {/* face */}
          <circle cx="60" cy="44" r="24" fill="url(#fur)" />
          {/* snout */}
          <ellipse cx="60" cy="52" rx="13" ry="10" fill="#e8cda0" />
          <circle cx="60" cy="47" r="3.4" fill="#2a2a2a" />
          {/* eyes — one winking, because it's that kind of dog */}
          <circle cx="50" cy="39" r="3.2" fill="#2a2a2a" />
          <path d="M66 39 q4 -2 8 0" stroke="#2a2a2a" strokeWidth="3" strokeLinecap="round" fill="none" />
          {/* tongue */}
          <path d="M57 58 q3 7 6 0 Z" fill="#ff6b81" />
          {/* little party sparkles */}
          <g fill="#ff4785">
            <circle className="dawg-spark s1" cx="20" cy="30" r="2.4" />
            <circle className="dawg-spark s2" cx="100" cy="36" r="2.4" />
            <circle className="dawg-spark s3" cx="96" cy="14" r="2" />
          </g>
        </g>
      </svg>
    </div>
  );
}

export function Connect() {
  const { dispatch } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onConnect() {
    setBusy(true);
    setErr(null);
    try {
      const up = await connectUp();
      dispatch({ type: 'connected', up });
      // Probe blob (Type-3) support in the background; forces text lane if the
      // wallet clearly can't sign Type-3 (the composer surfaces why). Skipped
      // (→ 'unknown') when the blob lane is off, and over WalletConnect, where
      // the probe's eth_signTransaction would pop an unasked-for request on
      // the user's phone.
      void initType3Probe(BLOBS_ENABLED && !up.viaWalletConnect ? up.eip1193 : null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card center welcome">
      <DancingDawg />
      <h1 className="welcome-title">UP&nbsp;Dawg</h1>
      <p className="welcome-tag">
        The on-chain wall where every bark is permanent. Post it, tag it, DM it —
        it all lives on LUKSO, forever, no take-backs. 🌭
      </p>

      <button className="connect-cta" disabled={busy} onClick={onConnect}>
        {busy ? 'Connecting…' : '🐾 Connect Universal Profile'}
      </button>
      {err && <p className="error">{err}</p>}
      <p className="hint">
        Use the UP Browser Extension or the UP Mobile app. Any Universal Profile will do.
      </p>

      <section className="whatsup">
        <h2>What’s UP, Dawg? 🐶</h2>
        <ul className="whatsup-list">
          <li>
            <span className="wu-ico">🧱</span>
            <span><b>The Wall</b> — shout into the clear. Posts are public and on-chain.
            Tag a UP to ping them, reply to thread it, repost to boost it.</span>
          </li>
          <li>
            <span className="wu-ico">🔒</span>
            <span><b>Encrypted DMs</b> — slide into someone’s inbox, end-to-end sealed.
            Only the two of you can read it; the chain just holds the ciphertext.</span>
          </li>
          <li>
            <span className="wu-ico">🫧</span>
            <span><b>Blobs</b> — bigger payloads ride an EIP-4844 blob. The body’s
            ephemeral (~18 days), only its hash is anchored. Cheap, roomy, fleeting.</span>
          </li>
          <li>
            <span className="wu-ico">👤</span>
            <span><b>Your face, your name</b> — your Universal Profile picture and
            @name show up automatically. No sign-up, no new password. Just connect.</span>
          </li>
        </ul>
        <p className="whatsup-foot small muted">
          No servers. No accounts. No cap. Your UP is your identity, the chain is the wall,
          and the dawg is just here to vibe.
        </p>
      </section>
    </div>
  );
}
