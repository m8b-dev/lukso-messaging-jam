// transport.ts — which lane NEW posts use (blob default), plus the wallet's
// Type-3 capability. Tiny global store + React hook so the composer and the DM
// box share one setting without threading props through the whole tree.
import { useEffect, useState } from 'react';
import {
  DEFAULT_TRANSPORT,
  BLOBS_ENABLED,
  RELAYER_CONFIGURED,
  type Transport,
} from './config';
import { probeType3, type Type3Support } from './blob';
import { ethers } from 'ethers';

let current: Transport = DEFAULT_TRANSPORT;
let type3: Type3Support = 'unknown';
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getTransport(): Transport {
  return current;
}
export function setTransport(t: Transport) {
  // Blob lane is hidden entirely when no relayer is configured — never let
  // anything (UI, restored state) select it.
  if (t === 'blob' && !BLOBS_ENABLED) t = 'text';
  if (t === current) return;
  current = t;
  emit();
}
export function getType3(): Type3Support {
  return type3;
}

/**
 * Probe the connected wallet once for Type-3 (blob tx) support. Type-3 only
 * matters for SELF-SEND (no relayer): if there is no relayer AND the wallet
 * can't sign Type-3, a blob can't be carried at all, so fall back to text. With
 * a relayer configured, the relayer submits the blob, so a no-Type-3 wallet
 * still posts blobs fine and we leave the transport alone. Call after connect.
 */
export async function initType3Probe(
  provider: ethers.Eip1193Provider | null | undefined,
): Promise<Type3Support> {
  type3 = await probeType3(provider);
  if (type3 === 'no' && current === 'blob' && !RELAYER_CONFIGURED) {
    current = 'text';
  }
  emit();
  return type3;
}

/**
 * Can a blob actually be SELF-SENT right now? True only when the connected
 * wallet signs Type-3. Used by the composer to label the submit path (relay vs
 * self-send) and by the lane guard when no relayer is configured.
 */
export function canSelfSend(): boolean {
  return type3 === 'yes';
}

export function useTransport(): {
  transport: Transport;
  setTransport: (t: Transport) => void;
  type3: Type3Support;
} {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return { transport: current, setTransport, type3 };
}
