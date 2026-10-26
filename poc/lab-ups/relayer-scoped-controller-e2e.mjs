// Historical MAINNET experiment; not part of offline tests. Explicit opt-in required.
if (process.env.UPDAWG_ALLOW_MAINNET_SEND !== '1') {
  throw new Error('Mainnet sends disabled. Review script, current contracts and cumulative budget before setting UPDAWG_ALLOW_MAINNET_SEND=1.');
}
// relayer-scoped-controller-e2e.mjs — add the RELAYER as a LEAST-PRIVILEGE LSP6
// controller on the service UP ("dawgtestup") deployed by svc-up-topology-e2e.
// LUKSO MAINNET, TEST NAMES. NOT a production deploy.
//
// Topology recap (from svc-up-topology-e2e-result.json): a single service UP owns
// the credit token + LSP9 vault; its KeyManager is the authority. So far only the
// ROOT svc controller (ALL_PERMISSIONS) could drive it. This wires a SECOND,
// scoped controller so the relayer can trigger airdrops WITHOUT the root key and
// WITHOUT any other power.
//
// Relayer controller scope (exactly, nothing more):
//   PERMISSIONS = CALL
//   AllowedCalls = one entry: (CALLTYPE.CALL, token, 0xffffffff, mint-selector)
// => the relayer may make the service UP call ONLY token.mint(...). It cannot
//    move the vault, cannot setData/settings, cannot add/edit controllers.
//
// Steps (each verified on chain):
//   1. load the deployed service UP + token + vault + svc root controller.
//   2. ADD the relayer as a controller: svc ROOT relays three setData writes on
//      the KM — bump AddressPermissions[] length, append relayer at index 1,
//      set its Permissions = CALL, set its AllowedCalls = {CALL: token:mint}.
//   3. POSITIVE: relayer (its OWN key, not the root key) relays
//      UP.execute(CALL, token, mint(alice, 1)) -> succeeds, alice +1 soulbound.
//   4. NEGATIVE a: relayer relays UP.execute(CALL, vault, vault.execute(... pay))
//      -> blocked by AllowedCalls (target not allowed).
//   5. NEGATIVE b: relayer relays UP.execute(CALL, token, transfer(...)) (wrong
//      selector on an allowed target) -> blocked by AllowedCalls (selector).
//   6. NEGATIVE c: relayer relays setData on the KM (add itself ALL_PERMISSIONS)
//      -> blocked (no ADDCONTROLLER/EDITPERMISSIONS/SETDATA permission).
//
// SPEND GUARD hard cap 1.0 LYX.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const require = createRequire(ROOT + '/poc/');
const { ethers } = require('ethers');

const EL = 'https://rpc.mainnet.lukso.network';
const CHAIN_ID = 42;
const LSP25_VERSION = 25;
const KEYDIR = process.env.UPDAWG_KEY_DIR || path.join(process.env.HOME || '', '.openclaw/credentials/updawg');
const STATEFILE = path.join(__dirname, 'state.json');
const TOPO = path.join(__dirname, 'svc-up-topology-e2e-result.json');
const SVC_KEYFILE = path.join(KEYDIR, '.svc-up-key.json');
const MAX_SPEND_LYX = 1.0;

// --- LSP6 data keys / constants (verified from @lukso/lsp6-contracts) ---
const AP_ARRAY_LENGTH = '0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3';
const AP_ARRAY_INDEX_PREFIX = '0xdf30dba06db6a30e65354d9a64c6098600000000000000000000000000000000'; // 16-byte prefix
const AP_PERMISSIONS_PREFIX = '0x4b80742de2bf82acb3630000'; // :Permissions:<addr>
const AP_ALLOWEDCALLS_PREFIX = '0x4b80742de2bf393a64c70000'; // :AllowedCalls:<addr>
const PERM_CALL = '0x0000000000000000000000000000000000000000000000000000000000000800';
const PERM_EXECUTE_RELAY_CALL = '0x0000000000000000000000000000000000000000000000000000000000400000';
// A controller that submits meta-txs via executeRelayCall needs EXECUTE_RELAY_CALL
// in addition to CALL (CALL alone -> NotAuthorised("EXECUTE_RELAY_CALL")).
const PERM_RELAYER = '0x0000000000000000000000000000000000000000000000000000000000400800'; // CALL | EXECUTE_RELAY_CALL
const PERM_ALL = '0x00000000000000000000000000000000000000000000000000000000007f3f7f';
const CALLTYPE_CALL = '0x00000002';
const ANY_STANDARD = '0xffffffff'; // any interface id

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const V = (n) => ethers.parseEther(n);

const KM_ABI = [
  'function getNonce(address signer, uint128 channel) view returns (uint256)',
  'function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)',
];
const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const SETDATA_BATCH_ABI = ['function setDataBatch(bytes32[] dataKeys, bytes[] dataValues)'];
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function soulbound(address) view returns (uint256)',
  'function mint(address to, uint256 amount, bool force, bytes data)',
  'function transfer(address from, address to, uint256 amount, bool force, bytes data)',
];
const VAULT_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const Y_ABI = ['function getData(bytes32) view returns (bytes)', 'function getDataBatch(bytes32[]) view returns (bytes[])'];

function lsp25Digest(km, nonce, validity, value, payload) {
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', km, LSP25_VERSION, CHAIN_ID, nonce, validity, value, payload]));
}
async function relayPayload({ provider, sender, kmAddr, ctrl, payload, gasLimit }) {
  const km = new ethers.Contract(kmAddr, KM_ABI, provider);
  const nonce = await km.getNonce(ctrl.address, 0n);
  const sig = ctrl.signingKey.sign(lsp25Digest(kmAddr, nonce, 0n, 0n, payload)).serialized;
  const outer = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, payload]);
  const fee = await provider.getFeeData();
  const tx = await sender.sendTransaction({ to: kmAddr, data: outer, type: 2, chainId: CHAIN_ID,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, gasLimit });
  return tx.wait();
}
async function relayUpExecute({ provider, sender, kmAddr, ctrl, target, value, innerData, gasLimit }) {
  const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, target, value, innerData]);
  return relayPayload({ provider, sender, kmAddr, ctrl, payload, gasLimit });
}

// one AllowedCalls entry = 0x0020 (32-byte element len) + callType(4) + addr(20) + standard(4) + selector(4)
function allowedCallsBlob(entries) {
  let out = '0x';
  for (const e of entries) {
    const body = e.callType.slice(2) + e.address.toLowerCase().slice(2) + e.standard.slice(2) + e.selector.slice(2);
    out += '0020' + body; // 0x0020 = 32 bytes element length
  }
  return out;
}

async function main() {
  console.log('=== E2E: relayer as a LEAST-PRIVILEGE LSP6 controller on service UP — LUKSO MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');

  const relayer = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  const svcCtrl = new ethers.Wallet(load(SVC_KEYFILE).privateKey); // ROOT controller of the service UP
  const topo = load(TOPO);
  const { svcUp, svcKm, token: tokenAddr, vault: vaultAddr } = topo.addresses;
  const st = load(STATEFILE);
  const aliceUp = ethers.getAddress(st.alice.upAddress);
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);
  const y = new ethers.Contract(svcUp, Y_ABI, provider);

  const mintSel = new ethers.Interface(TOKEN_ABI).getFunction('mint').selector;
  const transferSel = new ethers.Interface(TOKEN_ABI).getFunction('transfer').selector;

  const startBal = await provider.getBalance(relayer.address);
  const guard = async (label) => {
    const lyx = Number(ethers.formatEther(startBal - await provider.getBalance(relayer.address)));
    console.log(`    [spend so far: ${lyx.toFixed(5)} LYX]`);
    if (lyx > MAX_SPEND_LYX) throw new Error(`SPEND GUARD: ${lyx} > ${MAX_SPEND_LYX} at ${label}`);
  };
  console.log('relayer       :', relayer.address);
  console.log('svc root ctrl :', svcCtrl.address);
  console.log('service UP    :', svcUp, 'km', svcKm);
  console.log('token         :', tokenAddr, '| mint sel', mintSel, '| vault', vaultAddr, '\n');

  const out = { network: 'lukso-mainnet', topology: 'relayer-scoped-controller', svcUp, svcKm, token: tokenAddr, vault: vaultAddr, relayer: relayer.address, steps: {} };

  // ---- 1. read current controller array; find if relayer already present ----
  const lenRaw = await y.getData(AP_ARRAY_LENGTH);
  const curLen = lenRaw === '0x' ? 0 : Number(BigInt(lenRaw));
  let relayerIdx = -1;
  for (let i = 0; i < curLen; i++) {
    const k = AP_ARRAY_INDEX_PREFIX.slice(0, 34) + ethers.toBeHex(i, 16).slice(2);
    const v = await y.getData(k);
    if (v.toLowerCase() === relayer.address.toLowerCase()) { relayerIdx = i; break; }
  }
  console.log('[1] AddressPermissions[] length:', curLen, '| relayer already a controller at idx:', relayerIdx);
  const idxKey = AP_ARRAY_INDEX_PREFIX.slice(0, 34) + ethers.toBeHex(relayerIdx >= 0 ? relayerIdx : curLen, 16).slice(2);
  out.steps.read = { curLen, relayerIdx };

  // ---- 2. ADD/UPDATE relayer as a scoped controller (root relays setDataBatch) ----
  // Idempotent: if already present, only (re)write Permissions + AllowedCalls and
  // do NOT bump the array length or re-append the address.
  console.log('\n[2] set relayer scoped controller (CALL|EXECUTE_RELAY_CALL + AllowedCalls{CALL: token:mint}) via root');
  const allowed = allowedCallsBlob([{ callType: CALLTYPE_CALL, address: tokenAddr, standard: ANY_STANDARD, selector: mintSel }]);
  const keys = [
    AP_PERMISSIONS_PREFIX + relayer.address.toLowerCase().slice(2),
    AP_ALLOWEDCALLS_PREFIX + relayer.address.toLowerCase().slice(2),
  ];
  const values = [PERM_RELAYER, allowed];
  if (relayerIdx < 0) {
    keys.unshift(AP_ARRAY_LENGTH, idxKey);
    values.unshift(ethers.toBeHex(curLen + 1, 16), relayer.address);
  }
  const setBatch = new ethers.Interface(SETDATA_BATCH_ABI).encodeFunctionData('setDataBatch', [keys, values]);
  await relayPayload({ provider, sender: relayer, kmAddr: svcKm, ctrl: svcCtrl, payload: setBatch, gasLimit: 500000n });
  // verify (reference the perm/allowedCalls keys by content, not by position —
  // the idempotent-update path omits the length/index keys from `keys`)
  const permKey = AP_PERMISSIONS_PREFIX + relayer.address.toLowerCase().slice(2);
  const allowedKey = AP_ALLOWEDCALLS_PREFIX + relayer.address.toLowerCase().slice(2);
  const [permNow, allowedNow] = await y.getDataBatch([permKey, allowedKey]);
  console.log('    relayer Permissions:', permNow, '(== CALL|EXECUTE_RELAY_CALL:', permNow.toLowerCase() === PERM_RELAYER.toLowerCase(), ')');
  console.log('    relayer AllowedCalls:', allowedNow.slice(0, 20) + '…', '(set:', allowedNow.length > 2, ')');
  out.steps.addController = { index: relayerIdx >= 0 ? relayerIdx : curLen, permissions: permNow, allowedCallsSet: allowedNow.length > 2, allowedCalls: allowedNow };
  if (permNow.toLowerCase() !== PERM_RELAYER.toLowerCase()) throw new Error('FAIL: relayer permission not CALL|EXECUTE_RELAY_CALL');
  if (allowedNow.length <= 2) throw new Error('FAIL: AllowedCalls not set');
  await guard('add-controller');

  const sb = (a) => token.soulbound(a);
  const bal = (a) => token.balanceOf(a);
  const lyxOf = (a) => provider.getBalance(a);

  // ---- 3. POSITIVE: relayer mints via the UP (scoped) ----
  console.log('\n[3] POSITIVE: relayer (own key) -> UP.execute(CALL, token, mint(alice, 1)) must succeed');
  const before3 = await bal(aliceUp);
  const mintInner = new ethers.Interface(TOKEN_ABI).encodeFunctionData('mint', [aliceUp, V('1'), true, '0x']);
  const r3 = await relayUpExecute({ provider, sender: relayer, kmAddr: svcKm, ctrl: relayer, target: tokenAddr, value: 0n, innerData: mintInner, gasLimit: 400000n });
  const after3 = await bal(aliceUp), sb3 = await sb(aliceUp);
  console.log('    status:', r3.status, '| alice credit', ethers.formatEther(before3), '->', ethers.formatEther(after3), '| soulbound', ethers.formatEther(sb3));
  out.steps.positiveMint = { status: r3.status, before: before3.toString(), after: after3.toString(), ok: after3 === before3 + V('1') };
  if (after3 !== before3 + V('1')) throw new Error('FAIL: scoped relayer could not mint');
  await guard('positive-mint');

  // ---- 4. NEGATIVE a: relayer tries to move the vault -> AllowedCalls blocks (target) ----
  console.log('\n[4] NEGATIVE a: relayer -> UP.execute(CALL, vault, vault.execute(... 0.001)) must FAIL (target not allowed)');
  const seed = await lyxOf(vaultAddr);
  if (seed < V('0.002')) { await (await relayer.sendTransaction({ to: vaultAddr, value: V('0.002') })).wait(); }
  const before4 = await lyxOf(vaultAddr);
  const vInner = new ethers.Interface(VAULT_ABI).encodeFunctionData('execute', [0, relayer.address, V('0.001'), '0x']);
  let a_blocked = false, aErr = '';
  try { const r = await relayUpExecute({ provider, sender: relayer, kmAddr: svcKm, ctrl: relayer, target: vaultAddr, value: 0n, innerData: vInner, gasLimit: 500000n }); a_blocked = r.status === 0; }
  catch (e) { a_blocked = true; aErr = e.shortMessage || e.message; }
  const after4 = await lyxOf(vaultAddr);
  console.log('    blocked:', a_blocked, '| vault LYX unchanged:', after4 === before4, aErr ? '| ' + aErr : '');
  out.steps.negVaultTarget = { blocked: a_blocked || after4 === before4, unchanged: after4 === before4 };
  if (!(a_blocked || after4 === before4)) throw new Error('FAIL: scoped relayer moved the vault!');
  await guard('neg-vault');

  // ---- 5. NEGATIVE b: relayer calls token.transfer (allowed target, wrong selector) -> blocked ----
  console.log('\n[5] NEGATIVE b: relayer -> UP.execute(CALL, token, transfer(...)) must FAIL (selector not allowed)');
  const before5 = await bal(aliceUp);
  const badInner = new ethers.Interface(TOKEN_ABI).encodeFunctionData('transfer', [svcUp, relayer.address, V('1'), true, '0x']);
  let b_blocked = false, bErr = '';
  try { const r = await relayUpExecute({ provider, sender: relayer, kmAddr: svcKm, ctrl: relayer, target: tokenAddr, value: 0n, innerData: badInner, gasLimit: 400000n }); b_blocked = r.status === 0; }
  catch (e) { b_blocked = true; bErr = e.shortMessage || e.message; }
  const after5 = await bal(aliceUp);
  console.log('    blocked:', b_blocked, '| (selector', transferSel, 'not in AllowedCalls)', bErr ? '| ' + bErr : '');
  out.steps.negSelector = { blocked: b_blocked, transferSel };
  if (!b_blocked) throw new Error('FAIL: scoped relayer called a non-allowed selector');
  await guard('neg-selector');

  // ---- 6. NEGATIVE c: relayer tries to escalate (setData on KM to grant itself ALL) -> blocked ----
  console.log('\n[6] NEGATIVE c: relayer -> setData(own Permissions = ALL) must FAIL (no EDITPERMISSIONS/SETDATA)');
  const escKey = AP_PERMISSIONS_PREFIX + relayer.address.toLowerCase().slice(2);
  const escPayload = new ethers.Interface(['function setData(bytes32,bytes)']).encodeFunctionData('setData', [escKey, PERM_ALL]);
  let c_blocked = false, cErr = '';
  try { const r = await relayPayload({ provider, sender: relayer, kmAddr: svcKm, ctrl: relayer, payload: escPayload, gasLimit: 300000n }); c_blocked = r.status === 0; }
  catch (e) { c_blocked = true; cErr = e.shortMessage || e.message; }
  const permAfter = await y.getData(escKey);
  const stillScoped = permAfter.toLowerCase() === PERM_RELAYER.toLowerCase();
  console.log('    blocked:', c_blocked, '| relayer still only CALL|EXECUTE_RELAY_CALL:', stillScoped, cErr ? '| ' + cErr : '');
  out.steps.negEscalate = { blocked: c_blocked || stillScoped, stillScoped };
  if (!(c_blocked || stillScoped)) throw new Error('FAIL: scoped relayer escalated its own permissions!');
  await guard('neg-escalate');

  const totalSpent = Number(ethers.formatEther(startBal - await provider.getBalance(relayer.address)));
  out.verdict = 'PASS';
  out.totalSpentLYX = totalSpent.toFixed(6);
  fs.writeFileSync(path.join(__dirname, 'relayer-scoped-controller-e2e-result.json'), JSON.stringify(out, null, 2));
  console.log(`\n✅ VERDICT: PASS — relayer is a least-privilege controller: can mint via the UP, nothing else. spend ${totalSpent.toFixed(5)} LYX (cap ${MAX_SPEND_LYX}).`);
  console.log('   wrote relayer-scoped-controller-e2e-result.json');
}
main().catch((e) => { console.error('\n❌ RELAYER SCOPED CONTROLLER E2E FAILED:', e.shortMessage || e.message || e); process.exit(1); });
