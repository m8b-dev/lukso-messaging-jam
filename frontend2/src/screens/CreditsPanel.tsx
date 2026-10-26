// CreditsPanel.tsx — DEV panel: exercise the UP Dawg soulbound credit flow in
// the browser. NOT a production surface — it drives a TEST token behind a dev
// tab so B can click through the proven service-UP + scoped-relayer-mint design:
//   - live balance / soulbound / free read straight from chain,
//   - the airdrop gate (LSP3 profile present + LSP26 follow of the service UP)
//     shown with a one-click "Follow" to satisfy it,
//   - "Claim airdrop" -> the credit relayer mints N soulbound credits via the
//     service UP's scoped mint-only controller (the browser can't mint itself).
//
// The whole flow matches poc/lab-ups (svc-up-topology + relayer-scoped-controller
// + credit-relayer-service). Reads work with no wallet and no relayer; Claim
// needs the relayer URL (VITE_CREDIT_RELAYER_URL); Follow needs a connected UP.
import { useCallback, useEffect, useState } from 'react';
import { ethers } from 'ethers';
import type { UpSession } from '../lib/up';
import {
  balances,
  gate,
  claim,
  claimAvailable,
  relayerStatus,
  type RelayerStatus,
  followServiceUpCall,
  serviceUp,
  creditToken,
  type CreditBalances,
  type GateStatus,
} from '../lib/credits';
import { EXPLORER } from '../lib/config';

const UP_EXECUTE_ABI = [
  'function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)',
];

function short(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4);
}

export function CreditsPanel({ up }: { up: UpSession | null }) {
  const me = up?.address ?? null;
  const [bal, setBal] = useState<CreditBalances | null>(null);
  const [g, setG] = useState<GateStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [relay, setRelay] = useState<RelayerStatus | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setRelay(null);
    try { setRelay(await relayerStatus()); } catch { setRelay({ claimsEnabled: false, claimBlockReason: 'Credit relayer unavailable' }); }
    if (!me) { setBal(null); setG(null); return; }
    try {
      const [b, gs] = await Promise.all([balances(me), gate(me)]);
      setBal(b); setG(gs);
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    }
  }, [me]);

  useEffect(() => { refresh(); }, [refresh]);

  // Follow the service UP through the connected wallet (ERC725X execute of
  // LSP26.follow) — satisfies the gate's follow edge.
  const doFollow = async () => {
    if (!up) return;
    setBusy('follow'); setMsg(null);
    try {
      const { to, data } = followServiceUpCall();
      const upc = new ethers.Contract(up.address, UP_EXECUTE_ABI, up.signer);
      const tx = await upc.execute(0, to, 0, data);
      await tx.wait();
      setMsg({ kind: 'ok', text: 'Now following the service UP. Refreshing airdrop eligibility…' });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  const doClaim = async () => {
    if (!me) return;
    setBusy('claim'); setMsg(null);
    try {
      const r = await claim(me);
      setMsg({ kind: 'ok', text: `Minted ${r.minted} credits. tx ${short(r.txHash)}` });
      await refresh();
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally { setBusy(null); }
  };

  if (!me) {
    return (
      <div className="credits-panel">
        <p className="muted">Connect your Universal Profile to see and claim credits.</p>
        <TokenInfo />
      </div>
    );
  }

  const canClaim = claimAvailable() && relay?.claimsEnabled === true;

  return (
    <div className="credits-panel">
      <p className="muted small">Test credits on LUKSO mainnet. Following uses your wallet and may cost LYX. Claiming is sponsored. This panel tests the airdrop only; it does not enforce credit charging for wall posts.</p>
      <div className="credit-balances">
        <Stat label="Credits" value={bal ? fmt(bal.balance) : '…'} big />
        <Stat label="Soulbound" value={bal ? fmt(bal.soulbound) : '…'} hint="spend-only (airdropped)" />
        <Stat label="Free" value={bal ? fmt(bal.free) : '…'} hint="transferable (bought)" />
      </div>

      <div className="credit-gate">
        <h4>Airdrop gate</h4>
        <ul className="gate-checks">
          <li className={g?.hasLsp3 ? 'ok' : 'no'}>{g?.hasLsp3 ? '✅' : '⬜'} LSP3 profile set</li>
          <li className={g?.follows ? 'ok' : 'no'}>
            {g?.follows ? '✅' : '⬜'} Follows service UP
            {!g?.follows && (
              <button className="linklike" disabled={busy !== null} onClick={doFollow}>
                {busy === 'follow' ? 'following…' : 'follow now'}
              </button>
            )}
          </li>
        </ul>
      </div>

      <div className="credit-actions">
        <button
          className="btn primary"
          disabled={!canClaim || !g?.eligible || busy !== null}
          onClick={doClaim}
          title={!canClaim ? 'No credit relayer configured (set VITE_CREDIT_RELAYER_URL)' : !g?.eligible ? 'Satisfy the gate first' : ''}
        >
          {busy === 'claim' ? 'claiming…' : '🪙 Claim airdrop'}
        </button>
        <button className="btn" disabled={busy !== null} onClick={refresh}>↻ Refresh</button>
      </div>

      {!canClaim && (
        <p className="muted small">
          Claims unavailable: {relay?.claimBlockReason || 'checking relayer safety status…'}. Balances and gate are read-only chain checks.
        </p>
      )}
      {msg && <p role="status" className={msg.kind === 'ok' ? 'credit-msg ok' : 'credit-msg err'}>{msg.text}</p>}

      <TokenInfo me={me} />
    </div>
  );
}

function fmt(s: string): string {
  // credits are whole units; drop a trailing .0
  const n = Number(s);
  return Number.isInteger(n) ? String(n) : s;
}

function Stat({ label, value, hint, big }: { label: string; value: string; hint?: string; big?: boolean }) {
  return (
    <div className={big ? 'credit-stat big' : 'credit-stat'}>
      <div className="credit-stat-value">{value}</div>
      <div className="credit-stat-label">{label}</div>
      {hint && <div className="credit-stat-hint muted small">{hint}</div>}
    </div>
  );
}

function TokenInfo({ me }: { me?: string }) {
  return (
    <div className="credit-info muted small">
      <div>Token: <a href={`${EXPLORER}/address/${creditToken}`} target="_blank" rel="noreferrer">{short(creditToken)}</a> (TEST, soulbound LSP7)</div>
      <div>Service UP: <a href={`${EXPLORER}/address/${serviceUp}`} target="_blank" rel="noreferrer">{short(serviceUp)}</a> (owns token + vault)</div>
      {me && <div>You: <a href={`${EXPLORER}/address/${me}`} target="_blank" rel="noreferrer">{short(me)}</a></div>}
    </div>
  );
}
