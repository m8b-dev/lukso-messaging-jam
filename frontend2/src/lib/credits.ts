// credits.ts — read + claim the UP Dawg soulbound credit token from the browser.
//
// The credit flow proven in poc/lab-ups is: a service UP ("dawgtestup") owns an
// LSP7 soulbound credit token; a least-privilege relayer controller may only
// drive token.mint, behind an off-chain gate (LSP3 profile present + LSP26
// follow of the service UP). This module surfaces that for the dev Credits
// panel:
//   - balances() reads balance/soulbound DIRECTLY from chain (no relayer).
//   - gate()/claim() talk to the credit relayer service (it holds the only key
//     that can mint). Without a relayer URL, claim is unavailable but reads work.
//
// Nothing here is production: it drives a TEST token behind a dev-only panel.

import { ethers } from 'ethers';
import {
  CREDIT_TOKEN_ADDRESS,
  SERVICE_UP_ADDRESS,
  CREDIT_RELAYER_URL,
  LSP26_ADDRESS,
} from './config';
import { getReadProvider } from './rpc';

const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function soulbound(address) view returns (uint256)',
];
const LSP26_ABI = ['function isFollowing(address,address) view returns (bool)'];
/** LSP3Profile data key. */
const LSP3_KEY = '0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5';
const Y_ABI = ['function getData(bytes32) view returns (bytes)'];

export interface CreditBalances {
  /** total credits (decimal string) */
  balance: string;
  /** soulbound (spend-only) portion */
  soulbound: string;
  /** freely transferable portion (bought / treasury-sent) */
  free: string;
}

export interface GateStatus {
  eligible: boolean;
  hasLsp3: boolean;
  follows: boolean;
}

/** True when a claim can be attempted (relayer configured). */
export function claimAvailable(): boolean {
  return !!CREDIT_RELAYER_URL;
}

export interface RelayerStatus { claimsEnabled: boolean; claimBlockReason?: string; }

export async function relayerStatus(): Promise<RelayerStatus> {
  if (!CREDIT_RELAYER_URL) return { claimsEnabled: false, claimBlockReason: 'No credit relayer configured' };
  const res = await fetch(CREDIT_RELAYER_URL.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error('Credit relayer unavailable');
  const body = await res.json();
  return { claimsEnabled: body.ok === true && body.claimsEnabled === true, claimBlockReason: body.claimBlockReason || (body.claimsEnabled === true ? undefined : 'Claims disabled by operator') };
}

export const serviceUp = SERVICE_UP_ADDRESS;
export const creditToken = CREDIT_TOKEN_ADDRESS;

/** Read credit balances straight from chain — works with no relayer, no wallet. */
export async function balances(up: string): Promise<CreditBalances> {
  const provider = await getReadProvider();
  const token = new ethers.Contract(CREDIT_TOKEN_ADDRESS, TOKEN_ABI, provider);
  const [bal, sb] = await Promise.all([token.balanceOf(up), token.soulbound(up)]);
  return {
    balance: ethers.formatEther(bal),
    soulbound: ethers.formatEther(sb),
    free: ethers.formatEther(bal - sb),
  };
}

/**
 * Read the airdrop gate directly from chain (LSP3 profile present + LSP26 follow
 * of the service UP). The relayer enforces the SAME gate on /claim; reading it
 * here lets the UI explain exactly what's missing before the user tries.
 */
export async function gate(up: string): Promise<GateStatus> {
  const provider = await getReadProvider();
  const y = new ethers.Contract(up, Y_ABI, provider);
  const lsp26 = new ethers.Contract(LSP26_ADDRESS, LSP26_ABI, provider);
  const [lsp3, follows] = await Promise.all([
    y.getData(LSP3_KEY),
    lsp26.isFollowing(up, SERVICE_UP_ADDRESS),
  ]);
  const hasLsp3 = (lsp3 || '0x').length > 2;
  return { hasLsp3, follows, eligible: hasLsp3 && follows };
}

export interface ClaimResult {
  txHash: string;
  minted: string;
  balance?: string;
  soulbound?: string;
}

/** Ask the relayer to mint the gated airdrop to `up` (once per UP). */
export async function claim(up: string): Promise<ClaimResult> {
  if (!CREDIT_RELAYER_URL) throw new Error('no credit relayer configured');
  const res = await fetch(CREDIT_RELAYER_URL.replace(/\/$/, '') + '/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ up }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ? `${body.error}${body.hint ? ` — ${body.hint}` : ''}` : `claim failed (${res.status})`);
  return body as ClaimResult;
}

/**
 * Build the LSP26 follow(serviceUP) call the user signs through their own wallet
 * to satisfy the gate. Returns { to, data } for an ERC725X execute by the UP.
 * (The panel sends it via the connected signer; follow is a normal UP.execute.)
 */
export function followServiceUpCall(): { to: string; data: string } {
  const data = new ethers.Interface(['function follow(address)']).encodeFunctionData('follow', [SERVICE_UP_ADDRESS]);
  return { to: LSP26_ADDRESS, data };
}
