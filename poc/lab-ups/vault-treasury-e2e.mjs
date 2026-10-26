// Historical MAINNET experiment; not part of offline tests. Explicit opt-in required.
if (process.env.UPDAWG_ALLOW_MAINNET_SEND !== '1') {
  throw new Error('Mainnet sends disabled. Review script, current contracts and cumulative budget before setting UPDAWG_ALLOW_MAINNET_SEND=1.');
}
// vault-treasury-e2e.mjs — E2E on LUKSO MAINNET for the real LSP9 Vault treasury
// under a control-UP KeyManager, replacing the EOA treasury stand-in used in the
// earlier credit-token / distributor / blob E2Es. TEST NAMES only.
//
// Proves the DAO-CONCEPT §1-2 treasury mechanics on real chain:
//   1. deploy LSP9 Vault (owner = relayer EOA to start).
//   2. treasury RECEIVES: send LYX to the vault + move 1 TCRED credit into it
//      (the vault is the chargeback/clawback destination). Prove balances.
//   3. EOA-owner move: vault.execute(CALL, dest, value) pays LYX out — raw
//      owner control works.
//   4. HAND TO THE DAO: transferOwnership(vault -> alice UP as the control UP),
//      then relayed acceptOwnership() THROUGH alice's KeyManager (LSP14 2-step;
//      pending owner must accept in its own tx). Prove owner() == alice UP.
//   5. GOVERNED move: alice controller -> LSP25 relay -> UP.execute(CALL, vault,
//      0, vault.execute(CALL, dest, value)) — the vault pays out, driven only
//      through the KeyManager. This is the real governance execution path.
//   6. NEGATIVE: bob's UP tries the same governed move on the vault -> must fail
//      (bob UP is not the vault owner).
//
// SPEND GUARD hard cap 1 LYX. Uses the live soulbound token 0x2b2f..c9Ff and the
// lab UPs alice (control-UP stand-in) / bob (attacker).

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
const NM = path.join(ROOT, 'frontend2/node_modules');
const TOKEN = '0x2b2f368fd8F70F19c31b76C60b13e83015B1c9Ff';
const MAX_SPEND_LYX = 1.0;

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const V = (n) => ethers.parseEther(n);

const KM_ABI = [
  'function getNonce(address signer, uint128 channel) view returns (uint256)',
  'function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)',
];
const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const VAULT_ABI = [
  'function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)',
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newPendingOwner)',
  'function acceptOwnership()',
];
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function soulbound(address) view returns (uint256)',
  'function transfer(address from, address to, uint256 amount, bool force, bytes data)',
];

function lsp25Digest(km, nonce, validity, value, payload) {
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', km, LSP25_VERSION, CHAIN_ID, nonce, validity, value, payload]));
}
// Relay UP.execute(CALL, target, value, innerData) signed by ctrl, gas paid by `sender`.
async function relayUpExecute({ provider, sender, kmAddr, ctrl, target, value, innerData, gasLimit }) {
  const km = new ethers.Contract(kmAddr, KM_ABI, provider);
  const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, target, value, innerData]);
  const nonce = await km.getNonce(ctrl.address, 0n);
  const sig = ctrl.signingKey.sign(lsp25Digest(kmAddr, nonce, 0n, 0n, payload)).serialized;
  const outer = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, payload]);
  const fee = await provider.getFeeData();
  const tx = await sender.sendTransaction({ to: kmAddr, data: outer, type: 2, chainId: CHAIN_ID,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, gasLimit });
  return tx.wait();
}

function compileVaultBytecode() {
  const art = require(path.join(NM, '@lukso/lsp9-contracts/artifacts/LSP9Vault.json'));
  return { abi: art.abi, bytecode: art.bytecode };
}

async function main() {
  console.log('=== E2E: LSP9 Vault treasury under control-UP KeyManager — LUKSO MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');

  const relayer = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  const st = load(path.join(__dirname, 'state.json'));
  const aliceUp = ethers.getAddress(st.alice.upAddress), aliceKm = ethers.getAddress(st.alice.kmAddress);
  const bobUp = ethers.getAddress(st.bob.upAddress), bobKm = ethers.getAddress(st.bob.kmAddress);
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey);
  const bobCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-bob-key.json')).privateKey);
  const token = new ethers.Contract(TOKEN, TOKEN_ABI, provider);

  const startBal = await provider.getBalance(relayer.address);
  const guard = async (label) => {
    const lyx = Number(ethers.formatEther(startBal - await provider.getBalance(relayer.address)));
    console.log(`    [spend so far: ${lyx.toFixed(5)} LYX]`);
    if (lyx > MAX_SPEND_LYX) throw new Error(`SPEND GUARD: ${lyx} > ${MAX_SPEND_LYX} at ${label}`);
  };
  console.log('relayer      :', relayer.address, ethers.formatEther(startBal), 'LYX');
  console.log('control UP   :', aliceUp, '(DAO stand-in) km', aliceKm);
  console.log('attacker UP  :', bobUp, '\n');

  const out = { network: 'lukso-mainnet', steps: {} };

  // ---- 1. deploy LSP9 Vault (owner = relayer EOA) ----
  console.log('[1] deploy LSP9 Vault (owner = relayer EOA)');
  const { abi: VABI, bytecode } = compileVaultBytecode();
  const vault = await new ethers.ContractFactory(VABI, bytecode, relayer).deploy(relayer.address);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log('    vault:', vaultAddr, '| owner', await vault.owner());
  out.steps.deploy = { vault: vaultAddr, owner: await vault.owner() };
  await guard('deploy');

  const vaultIface = new ethers.Interface(VAULT_ABI);
  const lyxOf = (a) => provider.getBalance(a);
  const credOf = (a) => token.balanceOf(a);

  // ---- 2. treasury RECEIVES LYX + a credit ----
  console.log('\n[2] treasury receives: send 0.01 LYX to vault + seed 1 free TCRED from treasury EOA');
  await (await relayer.sendTransaction({ to: vaultAddr, value: V('0.01') })).wait();
  // Seed the vault's credit from the TREASURY EOA (holds a FREE credit from the
  // earlier clawback; soulbound==0). The treasury is the token's exempt address,
  // so this transfer is unrestricted. (A soulbound credit could NOT move here —
  // that restriction is exactly what stops faucet credits leaving a user.)
  await (await token.connect(relayer).transfer(relayer.address, vaultAddr, V('1'), true, '0x')).wait();
  const vLyx = await lyxOf(vaultAddr), vCred = await credOf(vaultAddr);
  console.log('    vault LYX', ethers.formatEther(vLyx), '| vault TCRED', ethers.formatEther(vCred));
  out.steps.receive = { vaultLyx: vLyx.toString(), vaultCredit: vCred.toString() };
  if (vLyx < V('0.01') || vCred < V('1')) throw new Error('FAIL: vault did not receive assets');
  await guard('receive');

  // ---- 3. EOA-owner move: vault pays 0.003 LYX back to relayer ----
  console.log('\n[3] EOA owner moves assets: vault.execute(CALL, relayer, 0.003 LYX)');
  const before3 = await lyxOf(vaultAddr);
  await (await vault.connect(relayer).execute(0, relayer.address, V('0.003'), '0x')).wait();
  const after3 = await lyxOf(vaultAddr);
  console.log('    vault LYX', ethers.formatEther(before3), '->', ethers.formatEther(after3));
  out.steps.ownerMove = { before: before3.toString(), after: after3.toString() };
  if (after3 !== before3 - V('0.003')) throw new Error('FAIL: owner move did not debit vault');
  await guard('owner-move');

  // ---- 4. hand the vault to the DAO control UP (LSP14 2-step) ----
  console.log('\n[4] hand vault to control UP: transferOwnership(alice UP) + relayed acceptOwnership()');
  await (await vault.connect(relayer).transferOwnership(aliceUp)).wait();
  console.log('    pendingOwner:', await vault.pendingOwner());
  // acceptOwnership must be called BY the pending owner (alice UP) -> relay through its KM.
  const acceptData = vaultIface.encodeFunctionData('acceptOwnership', []);
  await relayUpExecute({ provider, sender: relayer, kmAddr: aliceKm, ctrl: aliceCtrl, target: vaultAddr, value: 0n, innerData: acceptData, gasLimit: 400000n });
  const newOwner = await vault.owner();
  console.log('    vault owner ->', newOwner, '(== control UP:', ethers.getAddress(newOwner) === aliceUp, ')');
  out.steps.handover = { pendingWas: aliceUp, owner: newOwner, isControlUp: ethers.getAddress(newOwner) === aliceUp };
  if (ethers.getAddress(newOwner) !== aliceUp) throw new Error('FAIL: ownership not accepted by control UP');
  await guard('handover');

  // ---- 5. GOVERNED move through the KeyManager ----
  console.log('\n[5] governed move: control-UP KeyManager -> UP.execute(CALL, vault, vault.execute(CALL, relayer, 0.002 LYX))');
  const before5 = await lyxOf(vaultAddr);
  const innerVaultExec = vaultIface.encodeFunctionData('execute', [0, relayer.address, V('0.002'), '0x']);
  // alice UP calls vault.execute via its own execute: UP.execute(CALL, vault, 0, innerVaultExec)
  await relayUpExecute({ provider, sender: relayer, kmAddr: aliceKm, ctrl: aliceCtrl, target: vaultAddr, value: 0n, innerData: innerVaultExec, gasLimit: 500000n });
  const after5 = await lyxOf(vaultAddr);
  console.log('    vault LYX', ethers.formatEther(before5), '->', ethers.formatEther(after5));
  out.steps.governedMove = { before: before5.toString(), after: after5.toString(), ok: after5 === before5 - V('0.002') };
  if (after5 !== before5 - V('0.002')) throw new Error('FAIL: governed move did not debit vault');
  await guard('governed-move');

  // ---- 6. NEGATIVE: bob's UP tries to move vault assets -> must fail ----
  console.log('\n[6] NEGATIVE: bob UP tries vault.execute(CALL, bob, 0.002 LYX) -> must fail (not owner)');
  const before6 = await lyxOf(vaultAddr);
  const bobGrab = vaultIface.encodeFunctionData('execute', [0, bobUp, V('0.002'), '0x']);
  let blocked = false, bErr = '';
  try {
    const r = await relayUpExecute({ provider, sender: relayer, kmAddr: bobKm, ctrl: bobCtrl, target: vaultAddr, value: 0n, innerData: bobGrab, gasLimit: 500000n });
    blocked = r.status === 0; // LSP6 swallows inner revert into failed relay
  } catch (e) { blocked = true; bErr = e.shortMessage || e.message; }
  const after6 = await lyxOf(vaultAddr);
  const unchanged = after6 === before6;
  console.log('    reverted/failed:', blocked, '| vault LYX unchanged:', unchanged, bErr ? '| ' + bErr : '');
  out.steps.negative = { blocked: blocked || unchanged, vaultLyxUnchanged: unchanged };
  if (!(blocked || unchanged)) throw new Error('FAIL: non-owner drained the vault');
  await guard('negative');

  const totalSpent = Number(ethers.formatEther(startBal - await provider.getBalance(relayer.address)));
  out.verdict = 'PASS';
  out.totalSpentLYX = totalSpent.toFixed(6);
  out.vault = vaultAddr;
  out.vaultLyxFinal = (await lyxOf(vaultAddr)).toString();
  out.vaultCreditFinal = (await credOf(vaultAddr)).toString();
  fs.writeFileSync(path.join(__dirname, 'vault-treasury-e2e-result.json'), JSON.stringify(out, null, 2));
  console.log(`\n✅ VERDICT: PASS — vault treasury governed by the control-UP KeyManager. spend ${totalSpent.toFixed(5)} LYX (cap ${MAX_SPEND_LYX}).`);
  console.log('   vault', vaultAddr, '| final LYX', ethers.formatEther(await lyxOf(vaultAddr)), '| credit', ethers.formatEther(await credOf(vaultAddr)));
  console.log('   wrote vault-treasury-e2e-result.json');
}
main().catch((e) => { console.error('\n❌ VAULT E2E FAILED:', e.shortMessage || e.message || e); process.exit(1); });
