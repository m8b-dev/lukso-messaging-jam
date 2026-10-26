// Historical MAINNET experiment; not part of offline tests. Explicit opt-in required.
if (process.env.UPDAWG_ALLOW_MAINNET_SEND !== '1') {
  throw new Error('Mainnet sends disabled. Review script, current contracts and cumulative budget before setting UPDAWG_ALLOW_MAINNET_SEND=1.');
}
// blob-gated-e2e.mjs — FULL token-gated blob-post loop on LUKSO MAINNET, over
// the REAL soulbound credit token + Distributor airdrop already proven live.
// TEST NAMES only (TCRED). Reuses the deployed token/dist + alice's airdropped
// 10 soulbound credits (no re-deploy, no re-airdrop).
//
// Proves BOTH token-gated post scenarios, each posting a real EIP-4844 Type-3
// blob to WallV2 and enforcing "1 credit = 1 blob":
//
//   A. RELAYER-SPONSORED: user authorizes relayer as a BOUNDED operator; relayer
//      pays gas, posts the Type-3 blob through the UP (LSP25 executeRelayCall),
//      then claws back exactly 1 credit (soulbound consumed first). Quota gate:
//      relayer must REFUSE when the user's credit balance is 0.
//
//   B. SELF-SEND (no relayer): the user's OWN controller pays gas and sends the
//      Type-3 blob directly (self-relay via executeRelayCall), and the post is
//      gated by the user BURNING 1 credit (soulbound burn allowed). Same quota
//      rule: at 0 credits the client must refuse to post.
//
// Both recover the blob body from the beacon to prove the payload actually rode
// the tx (not a silent Type-2 data loss). SPEND GUARD hard cap 1 LYX.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const POC = ROOT + '/poc';
const require = createRequire(POC + '/');
const { ethers } = require('ethers');
const { loadKZG } = require('kzg-wasm');

const EL = 'https://rpc.mainnet.lukso.network';
const CL = 'https://rpc.mainnet.lukso.network';
const CHAIN_ID = 42;
const LSP25_VERSION = 25;
const KEYDIR = process.env.UPDAWG_KEY_DIR || path.join(process.env.HOME || '', '.openclaw/credentials/updawg');
const WALLV2 = '0x480f1913A546E99e34B313ab7c9dDFc294aF2c07';
const TOKEN = '0x2b2f368fd8F70F19c31b76C60b13e83015B1c9Ff'; // deployed TCRED (soulbound)
const TREASURY = '0x80B890Cd922925d0D74c99c9FaC3f17a66640135'; // dao/treasury EOA stand-in (exempt)
const MAX_SPEND_LYX = 1.0;

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const enc = new TextEncoder();
const dec = new TextDecoder();

// ---- blob codec + versioned hash (same bytes as proven spikes) -------------
const FIELD_ELEMENTS = 4096, BLOB_SIZE = FIELD_ELEMENTS * 32;
function encodeBlob(payload) {
  const blob = new Uint8Array(BLOB_SIZE);
  const len = payload.length;
  blob[28] = (len >>> 24) & 0xff; blob[29] = (len >>> 16) & 0xff; blob[30] = (len >>> 8) & 0xff; blob[31] = len & 0xff;
  let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) { const b = w * 32 + 1; for (let i = 0; i < 31 && o < len; i++) blob[b + i] = payload[o++]; }
  return blob;
}
function decodeBlob(blob) {
  const len = (blob[28] << 24) | (blob[29] << 16) | (blob[30] << 8) | blob[31];
  const out = new Uint8Array(len); let o = 0;
  for (let w = 1; w < FIELD_ELEMENTS && o < len; w++) { const b = w * 32 + 1; for (let i = 0; i < 31 && o < len; i++) out[o++] = blob[b + i]; }
  return out;
}
function versionedHashOfBlob(kzg, blobHex) {
  const probe = ethers.Transaction.from({ type: 3, to: WALLV2, chainId: CHAIN_ID, nonce: 0, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 1n, gasLimit: 21000n, data: '0x', blobs: [blobHex], kzg });
  return probe.blobVersionedHashes[0];
}

// ---- beacon retrieval ------------------------------------------------------
let genesis = null;
async function beaconGenesis() { if (genesis == null) genesis = Number((await (await fetch(CL + '/eth/v1/beacon/genesis')).json()).data.genesis_time); return genesis; }
function vhOfCommitment(commitHex) { const c = Buffer.from(commitHex.slice(2), 'hex'); const h = crypto.createHash('sha256').update(c).digest(); h[0] = 0x01; return '0x' + h.toString('hex'); }
async function fetchBlobBody(provider, txHash, anchoredHash) {
  const rcpt = await provider.getTransactionReceipt(txHash);
  const blk = await provider.getBlock(rcpt.blockNumber);
  const slot = Math.floor((Number(blk.timestamp) - (await beaconGenesis())) / 12);
  const res = await fetch(CL + `/eth/v1/beacon/blob_sidecars/${slot}`);
  if (!res.ok) throw new Error('sidecars ' + res.status);
  const scs = (await res.json()).data ?? [];
  for (const sc of scs) if (vhOfCommitment(sc.kzg_commitment).toLowerCase() === anchoredHash.toLowerCase()) return decodeBlob(Buffer.from(sc.blob.slice(2), 'hex'));
  throw new Error('no sidecar matched (pruned/mismatch)');
}

// ---- LSP25 digest (EIP-191 v0, PACKED) -------------------------------------
function lsp25Digest(km, nonce, validity, value, payload) {
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', km, LSP25_VERSION, CHAIN_ID, nonce, validity, value, payload]));
}
const KM_ABI = [
  'function getNonce(address signer, uint128 channel) view returns (uint256)',
  'function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)',
];
const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const WALL_ABI = [
  'function postBlob(address tag, bool encrypted, bytes32 threadId, bytes32 blobHash, bytes meta) external',
  'event PostedBlob(uint256 indexed id, address indexed from, address indexed tag, bool encrypted, bytes32 threadId, uint64 timestamp, bytes32 blobHash, bytes meta)',
];
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function soulbound(address) view returns (uint256)',
  'function authorizedAmountFor(address operator, address holder) view returns (uint256)',
  'function authorizeOperator(address operator, uint256 amount, bytes data)',
  'function transfer(address from, address to, uint256 amount, bool force, bytes data)',
  'function burn(address from, uint256 amount, bytes data)',
];

// Build controller-signed executeRelayCall calldata for a postBlob through the UP.
async function buildPostBlobRelay({ provider, kmAddr, ctrl, blobHash, meta }) {
  const km = new ethers.Contract(kmAddr, KM_ABI, provider);
  const postBlobData = new ethers.Interface(WALL_ABI).encodeFunctionData('postBlob', [ethers.ZeroAddress, false, ethers.ZeroHash, blobHash, meta]);
  const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, WALLV2, 0, postBlobData]);
  const nonce = await km.getNonce(ctrl.address, 0n);
  const digest = lsp25Digest(kmAddr, nonce, 0n, 0n, payload);
  const sig = ctrl.signingKey.sign(digest).serialized;
  const outerData = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, payload]);
  return outerData;
}

async function main() {
  console.log('=== E2E: token-gated Type-3 blob post — BOTH scenarios — LUKSO MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');
  const kzg = await loadKZG();

  const relayer = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  const st = load(path.join(__dirname, 'state.json'));
  const aliceUp = ethers.getAddress(st.alice.upAddress), aliceKm = ethers.getAddress(st.alice.kmAddress);
  const aliceCtrlWallet = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey, provider); // funded, pays gas in B
  const aliceCtrl = aliceCtrlWallet; // same key (signs LSP25 + pays gas in self-send)
  const token = new ethers.Contract(TOKEN, TOKEN_ABI, provider);
  const wall = new ethers.Interface(WALL_ABI);

  const startBal = await provider.getBalance(relayer.address);
  const startCtrl = await provider.getBalance(aliceCtrl.address);
  const guard = async (label) => {
    const spent = (startBal - await provider.getBalance(relayer.address)) + (startCtrl - await provider.getBalance(aliceCtrl.address));
    const lyx = Number(ethers.formatEther(spent));
    console.log(`    [combined spend so far: ${lyx.toFixed(5)} LYX]`);
    if (lyx > MAX_SPEND_LYX) throw new Error(`SPEND GUARD: ${lyx} > ${MAX_SPEND_LYX} at ${label}`);
  };

  const bal = (a) => token.balanceOf(a);
  const sb = (a) => token.soulbound(a);
  console.log('relayer/treasury:', relayer.address, ethers.formatEther(startBal), 'LYX');
  console.log('alice UP        :', aliceUp, '| controller', aliceCtrl.address, ethers.formatEther(startCtrl), 'LYX');
  console.log('credit balance  :', ethers.formatEther(await bal(aliceUp)), 'TCRED | soulbound', ethers.formatEther(await sb(aliceUp)), '\n');

  const ONE = ethers.parseEther('1');
  const out = { network: 'lukso-mainnet', token: TOKEN, scenarios: {} };
  if (await bal(aliceUp) < 2n * ONE) throw new Error('precondition: alice needs >=2 TCRED (airdrop); has ' + ethers.formatEther(await bal(aliceUp)));

  // ================= SCENARIO A: relayer-sponsored =========================
  console.log('--- SCENARIO A: relayer-sponsored (relayer pays gas, claws back 1 credit) ---');

  // quota gate: relayer checks the user actually has credit before posting.
  const quotaA = await bal(aliceUp);
  console.log('[A1] quota gate: credit balance', ethers.formatEther(quotaA), '-> allowed:', quotaA >= ONE);
  if (quotaA < ONE) throw new Error('UPGRADE_REQUIRED: relayer would refuse (0 credit)');

  // authorize relayer as BOUNDED operator (1 for this post) via LSP25.
  console.log('[A2] authorize relayer operator bounded=1 (LSP25 relayed)');
  const authData = new ethers.Interface(TOKEN_ABI).encodeFunctionData('authorizeOperator', [relayer.address, ONE, '0x']);
  const authExec = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, TOKEN, 0, authData]);
  {
    const km = new ethers.Contract(aliceKm, KM_ABI, provider);
    const nonce = await km.getNonce(aliceCtrl.address, 0n);
    const sig = aliceCtrl.signingKey.sign(lsp25Digest(aliceKm, nonce, 0n, 0n, authExec)).serialized;
    const outer = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, authExec]);
    const fee = await provider.getFeeData();
    await (await relayer.sendTransaction({ to: aliceKm, data: outer, type: 2, chainId: CHAIN_ID, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, gasLimit: 300000n })).wait();
  }
  const authedA = await token.authorizedAmountFor(relayer.address, aliceUp);
  console.log('    authorizedAmountFor(relayer,alice) =', ethers.formatEther(authedA));
  await guard('A-authorize');

  // relayer posts the Type-3 blob through the UP (pays gas).
  console.log('[A3] relayer posts Type-3 blob through UP (LSP25 executeRelayCall, relayer pays gas)');
  const bodyA = enc.encode(`relayer-sponsored gated blob — alice UP — ${new Date().toISOString()}`);
  const blobHexA = '0x' + Buffer.from(encodeBlob(bodyA)).toString('hex');
  const blobHashA = versionedHashOfBlob(kzg, blobHexA);
  const metaA = enc.encode(JSON.stringify({ v: 1, via: 'relayer', len: bodyA.length }));
  const outerA = await buildPostBlobRelay({ provider, kmAddr: aliceKm, ctrl: aliceCtrl, blobHash: blobHashA, meta: metaA });
  const feeA = await provider.getFeeData();
  const txA = await relayer.sendTransaction({ type: 3, to: aliceKm, data: outerA, chainId: CHAIN_ID,
    maxFeePerGas: feeA.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'), maxPriorityFeePerGas: feeA.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'), gasLimit: 600000n, blobs: [blobHexA], kzg });
  const rA = await txA.wait();
  const evA = rA.logs.map((l) => { try { return wall.parseLog(l); } catch { return null; } }).find((p) => p && p.name === 'PostedBlob');
  if (!evA) throw new Error('A FAIL: no PostedBlob');
  const fromA = ethers.getAddress(evA.args.from);
  const bodyGotA = dec.decode(await fetchBlobBody(provider, txA.hash, blobHashA));
  const okBodyA = bodyGotA === dec.decode(bodyA);
  console.log('    PostedBlob id', evA.args.id.toString(), 'from', fromA, 'isUP', fromA === aliceUp, '| body recovered', okBodyA);
  if (fromA !== aliceUp || !okBodyA) throw new Error('A FAIL: post/blob binding');
  await guard('A-post');

  // chargeback: relayer (operator) pulls exactly 1 credit (soulbound consumed).
  console.log('[A4] chargeback: relayer pulls 1 credit (soulbound consumed)');
  const aBefore = await bal(aliceUp), sbBefore = await sb(aliceUp);
  await (await token.connect(relayer).transfer(aliceUp, TREASURY, ONE, true, txA.hash)).wait();
  const aAfter = await bal(aliceUp), sbAfter = await sb(aliceUp), authAfterA = await token.authorizedAmountFor(relayer.address, aliceUp);
  console.log(`    credit ${ethers.formatEther(aBefore)}->${ethers.formatEther(aAfter)} | soulbound ${ethers.formatEther(sbBefore)}->${ethers.formatEther(sbAfter)} | allowance ->${ethers.formatEther(authAfterA)}`);
  if (aAfter !== aBefore - ONE) throw new Error('A FAIL: not debited exactly 1');
  if (sbAfter !== sbBefore - ONE) throw new Error('A FAIL: soulbound not consumed');
  out.scenarios.relayer = { postTx: txA.hash, postedId: evA.args.id.toString(), from: fromA, bodyRecovered: okBodyA,
    creditBefore: aBefore.toString(), creditAfter: aAfter.toString(), soulboundAfter: sbAfter.toString(), allowanceAfter: authAfterA.toString() };
  await guard('A-chargeback');

  // ================= SCENARIO B: self-send (no relayer) =====================
  console.log('\n--- SCENARIO B: self-send (user pays own gas, burns 1 credit — no relayer) ---');
  const quotaB = await bal(aliceUp);
  console.log('[B1] quota gate (client-side): credit balance', ethers.formatEther(quotaB), '-> allowed:', quotaB >= ONE);
  if (quotaB < ONE) throw new Error('B precondition: alice out of credit');

  // user's OWN controller sends the Type-3 blob directly (self-relay). Pays gas.
  console.log('[B2] user controller self-sends Type-3 blob (executeRelayCall to own KM, controller pays gas)');
  const bodyB = enc.encode(`self-send gated blob — alice UP pays own gas — ${new Date().toISOString()}`);
  const blobHexB = '0x' + Buffer.from(encodeBlob(bodyB)).toString('hex');
  const blobHashB = versionedHashOfBlob(kzg, blobHexB);
  const metaB = enc.encode(JSON.stringify({ v: 1, via: 'self-send', len: bodyB.length }));
  const outerB = await buildPostBlobRelay({ provider, kmAddr: aliceKm, ctrl: aliceCtrl, blobHash: blobHashB, meta: metaB });
  const feeB = await provider.getFeeData();
  // KEY DIFFERENCE vs A: sender is the USER's own controller, not the relayer.
  const txB = await aliceCtrlWallet.sendTransaction({ type: 3, to: aliceKm, data: outerB, chainId: CHAIN_ID,
    maxFeePerGas: feeB.maxFeePerGas ?? ethers.parseUnits('3', 'gwei'), maxPriorityFeePerGas: feeB.maxPriorityFeePerGas ?? ethers.parseUnits('1', 'gwei'),
    maxFeePerBlobGas: ethers.parseUnits('10', 'gwei'), gasLimit: 600000n, blobs: [blobHexB], kzg });
  const rB = await txB.wait();
  const evB = rB.logs.map((l) => { try { return wall.parseLog(l); } catch { return null; } }).find((p) => p && p.name === 'PostedBlob');
  if (!evB) throw new Error('B FAIL: no PostedBlob');
  const fromB = ethers.getAddress(evB.args.from);
  const bodyGotB = dec.decode(await fetchBlobBody(provider, txB.hash, blobHashB));
  const okBodyB = bodyGotB === dec.decode(bodyB);
  console.log('    PostedBlob id', evB.args.id.toString(), 'from', fromB, 'isUP', fromB === aliceUp, '| body recovered', okBodyB, '| gas payer = user controller');
  if (fromB !== aliceUp || !okBodyB) throw new Error('B FAIL: post/blob binding');
  await guard('B-post');

  // token gate for self-send: the user BURNS 1 credit (soulbound burn allowed).
  console.log('[B3] token gate: user burns 1 credit for the post (relayed burn, soulbound consumed)');
  const bBefore = await bal(aliceUp), bSbBefore = await sb(aliceUp);
  const burnData = new ethers.Interface(TOKEN_ABI).encodeFunctionData('burn', [aliceUp, ONE, '0x']);
  const burnExec = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, TOKEN, 0, burnData]);
  {
    const km = new ethers.Contract(aliceKm, KM_ABI, provider);
    const nonce = await km.getNonce(aliceCtrl.address, 0n);
    const sig = aliceCtrl.signingKey.sign(lsp25Digest(aliceKm, nonce, 0n, 0n, burnExec)).serialized;
    const outer = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, burnExec]);
    const fee = await provider.getFeeData();
    // user pays their own gas here too (self-send scenario)
    await (await aliceCtrlWallet.sendTransaction({ to: aliceKm, data: outer, type: 2, chainId: CHAIN_ID, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, gasLimit: 300000n })).wait();
  }
  const bAfter = await bal(aliceUp), bSbAfter = await sb(aliceUp);
  console.log(`    credit ${ethers.formatEther(bBefore)}->${ethers.formatEther(bAfter)} | soulbound ${ethers.formatEther(bSbBefore)}->${ethers.formatEther(bSbAfter)}`);
  if (bAfter !== bBefore - ONE) throw new Error('B FAIL: burn did not consume exactly 1');
  if (bSbAfter !== bSbBefore - ONE) throw new Error('B FAIL: soulbound not consumed on burn');
  out.scenarios.selfSend = { postTx: txB.hash, postedId: evB.args.id.toString(), from: fromB, bodyRecovered: okBodyB,
    gasPayer: 'user-controller', creditBefore: bBefore.toString(), creditAfter: bAfter.toString(), soulboundAfter: bSbAfter.toString() };
  await guard('B-burn');

  const spent = (startBal - await provider.getBalance(relayer.address)) + (startCtrl - await provider.getBalance(aliceCtrl.address));
  out.verdict = 'PASS';
  out.totalSpentLYX = Number(ethers.formatEther(spent)).toFixed(6);
  out.creditFinal = (await bal(aliceUp)).toString();
  out.soulboundFinal = (await sb(aliceUp)).toString();
  fs.writeFileSync(path.join(__dirname, 'blob-gated-e2e-result.json'), JSON.stringify(out, null, 2));
  console.log(`\n✅ VERDICT: PASS — both scenarios posted a real Type-3 blob + burned exactly 1 credit each.`);
  console.log(`   combined spend ${out.totalSpentLYX} LYX (cap ${MAX_SPEND_LYX}); alice credit now ${ethers.formatEther(await bal(aliceUp))} TCRED (all soulbound).`);
  console.log('   wrote blob-gated-e2e-result.json');
}
main().catch((e) => { console.error('\n❌ BLOB-GATED E2E FAILED:', e.shortMessage || e.message || e); process.exit(1); });
