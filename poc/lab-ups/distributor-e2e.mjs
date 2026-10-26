// Historical MAINNET experiment; not part of offline tests. Explicit opt-in required.
if (process.env.UPDAWG_ALLOW_MAINNET_SEND !== '1') {
  throw new Error('Mainnet sends disabled. Review script, current contracts and cumulative budget before setting UPDAWG_ALLOW_MAINNET_SEND=1.');
}
// distributor-e2e.mjs — E2E on LUKSO MAINNET for the airdrop gate
// (contracts/dao/CreditDistributor.sol) over the soulbound credit token
// (contracts/dao/DawgToken.sol). TEST NAMES only (NOT final DAWG branding).
//
// Proves, on real chain with funded controllers, the SYBIL GATE:
//   LSP3 profile present  AND  LSP26 follow(daoUP)  -> one-time airdrop of N.
//
// Steps:
//   1. deploy token (owner=relayer), deploy Distributor(dao=relayer stand-in,
//      N=10), transferOwnership(token -> Distributor) so it can mint.
//   2. GATE REJECTS BARE UP: eligible(alice) == (false,"not-following-dao");
//      claimFor(alice) reverts (no profile, no follow).
//   3. SIGNAL A: alice sets an LSP3 profile (relayed UP.execute -> setData).
//      Still rejected: eligible(alice) == (false,"not-following-dao").
//   4. SIGNAL B: alice follow(daoUP) via relayed UP.execute -> LSP26.follow.
//   5. GATE PASSES: eligible(alice) == (true,""); claimFor(alice) mints 10
//      SOULBOUND credits -> balance 10, soulbound 10.
//   6. ONCE PER UP: second claimFor(alice) reverts AlreadyClaimed.
//   7. NEGATIVE CONTROL: bob (bare UP) still rejected.
//
// SPEND GUARD: hard self-cap MAX_SPEND_LYX (1). Task cap is 2 LYX total.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const require = createRequire(ROOT + '/poc/');
const { ethers } = require('ethers');
const solc = require('solc');

const EL = 'https://rpc.mainnet.lukso.network';
const CHAIN_ID = 42;
const LSP25_VERSION = 25;
const KEYDIR = process.env.UPDAWG_KEY_DIR || path.join(process.env.HOME || '', '.openclaw/credentials/updawg');
const NM = path.join(ROOT, 'frontend2/node_modules');
const TOKEN_SRC = path.join(ROOT, 'contracts/dao/DawgToken.sol');
const DIST_SRC = path.join(ROOT, 'contracts/dao/CreditDistributor.sol');
const MAX_SPEND_LYX = 1.0;
const TOKEN_CAP = ethers.parseEther('1000000');
const N = 10n; // distributionAmount (credits per airdrop)

const LSP26 = '0xf01103E5a9909Fc0DBe8166dA7085e0285daDDcA';
const LSP3_KEY = '0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5';

const loadPk = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).privateKey;

// ---- compile a single .sol against frontend2/node_modules import resolver ----
function compile(srcPath, contractName) {
  const resolve = (p) => { const c = path.join(NM, p); return fs.existsSync(c) ? c : null; };
  const findImports = (p) => { const abs = resolve(p); return abs ? { contents: fs.readFileSync(abs, 'utf8') } : { error: 'not found: ' + p }; };
  const base = path.basename(srcPath);
  const input = {
    language: 'Solidity',
    sources: { [base]: { content: fs.readFileSync(srcPath, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { errs.slice(0, 10).forEach((e) => console.error(e.formattedMessage)); throw new Error('compile failed: ' + base); }
  const c = out.contracts[base][contractName];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// ---- LSP25 relay plumbing (same as proven spikes) --------------------------
const KM_ABI = [
  'function getNonce(address signer, uint128 channel) view returns (uint256)',
  'function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)',
];
const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const SETDATA_ABI = ['function setData(bytes32 dataKey, bytes dataValue)'];

function lsp25Digest(km, nonce, validity, value, payload) {
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', km, LSP25_VERSION, CHAIN_ID, nonce, validity, value, payload]));
}
// Relay an arbitrary KeyManager payload (already-encoded) signed by ctrl.
async function relayPayload({ provider, relayer, kmAddr, ctrl, payload, gasLimit }) {
  const km = new ethers.Contract(kmAddr, KM_ABI, provider);
  const nonce = await km.getNonce(ctrl.address, 0n);
  const digest = lsp25Digest(kmAddr, nonce, 0n, 0n, payload);
  const sig = ctrl.signingKey.sign(digest).serialized;
  const outer = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, payload]);
  const fee = await provider.getFeeData();
  const tx = await relayer.sendTransaction({ to: kmAddr, data: outer, type: 2, chainId: CHAIN_ID,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, gasLimit });
  return tx.wait();
}
// External CALL from the UP: execute(0, target, 0, innerData).
async function relayExec({ provider, relayer, kmAddr, ctrl, target, innerData, gasLimit }) {
  const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, target, 0, innerData]);
  return relayPayload({ provider, relayer, kmAddr, ctrl, payload, gasLimit });
}
// Direct setData on the KeyManager (first-class LSP6 op, SETDATA permission).
async function relaySetData({ provider, relayer, kmAddr, ctrl, dataKey, dataValue, gasLimit }) {
  const payload = new ethers.Interface(SETDATA_ABI).encodeFunctionData('setData', [dataKey, dataValue]);
  return relayPayload({ provider, relayer, kmAddr, ctrl, payload, gasLimit });
}

async function main() {
  console.log('=== E2E: airdrop sybil gate (Distributor, TEST NAMES) — LUKSO MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');

  const relayer = new ethers.Wallet(loadPk(path.join(KEYDIR, '.z-lukso-key.json')), provider);
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
  const aliceUp = ethers.getAddress(st.alice.upAddress), aliceKm = ethers.getAddress(st.alice.kmAddress);
  const bobUp = ethers.getAddress(st.bob.upAddress);
  const aliceCtrl = new ethers.Wallet(loadPk(path.join(KEYDIR, '.lab-alice-key.json')));
  const daoUp = relayer.address; // stand-in for the DAO control UP users must follow
  const ONE = ethers.parseEther('1');

  const startBal = await provider.getBalance(relayer.address);
  const guard = async (label) => {
    const spent = startBal - await provider.getBalance(relayer.address);
    const lyx = Number(ethers.formatEther(spent));
    console.log(`    [spend so far: ${lyx.toFixed(5)} LYX]`);
    if (lyx > MAX_SPEND_LYX) throw new Error(`SPEND GUARD: ${lyx} > ${MAX_SPEND_LYX} LYX at ${label}`);
  };

  console.log('relayer/dao  :', relayer.address, ethers.formatEther(startBal), 'LYX');
  console.log('alice UP     :', aliceUp, 'km', aliceKm);
  console.log('bob UP       :', bobUp, '(negative control)\n');

  const out = { network: 'lukso-mainnet', tokenNames: { name: 'Test Credit', symbol: 'TCRED' }, N: N.toString(), steps: {} };

  // ---- 1. deploy token + distributor, hand token ownership to distributor ----
  console.log('[1] deploy token (owner=relayer) + Distributor(dao, N=10), transferOwnership(token->Distributor)');
  const tk = compile(TOKEN_SRC, 'DawgToken');
  const token = await new ethers.ContractFactory(tk.abi, tk.bytecode, relayer).deploy('Test Credit', 'TCRED', relayer.address, TOKEN_CAP);
  await token.waitForDeployment();
  const tokAddr = await token.getAddress();
  await (await token.setTreasury(daoUp)).wait(); // dao/treasury stand-in is exempt

  const di = compile(DIST_SRC, 'CreditDistributor');
  const dist = await new ethers.ContractFactory(di.abi, di.bytecode, relayer).deploy(
    relayer.address, tokAddr, LSP26, daoUp, N * ONE);
  await dist.waitForDeployment();
  const distAddr = await dist.getAddress();

  await (await token.transferOwnership(distAddr)).wait(); // distributor can now mint
  const newOwner = await token.owner();
  console.log('    token:', tokAddr, '| distributor:', distAddr, '| token.owner ->', newOwner);
  if (ethers.getAddress(newOwner) !== ethers.getAddress(distAddr)) throw new Error('FAIL: ownership not transferred');
  out.steps.deploy = { token: tokAddr, distributor: distAddr, dao: daoUp, tokenOwner: newOwner };
  await guard('deploy');

  const sb = (a) => token.soulbound(a);
  const bal = (a) => token.balanceOf(a);

  // ---- 2. gate rejects a bare UP ----
  console.log('\n[2] GATE REJECTS BARE UP: eligible(alice) + claimFor(alice) must revert');
  let [ok, reason] = await dist.eligible(aliceUp);
  console.log('    eligible(alice) =', ok, JSON.stringify(reason));
  let rejected = false, rErr = '';
  try { await dist.claimFor.staticCall(aliceUp); } catch (e) { rejected = true; rErr = e.shortMessage || e.message; }
  console.log('    claimFor(alice) reverts:', rejected, rErr ? '| ' + rErr : '');
  out.steps.rejectBare = { eligible: ok, reason, claimReverts: rejected };
  if (ok || !rejected) throw new Error('FAIL: bare UP was NOT rejected');
  await guard('reject-bare');

  // ---- 3. signal A: alice sets an LSP3 profile ----
  console.log('\n[3] SIGNAL A: alice sets an LSP3 profile (relayed setData)');
  // minimal non-empty LSP3Profile value (VerifiableURI-ish blob; only length matters to the gate)
  const profileValue = '0x00006f357c6a0020' + 'ab'.repeat(32) + '697066733a2f2f'; // junk bytes, non-empty
  await relaySetData({ provider, relayer, kmAddr: aliceKm, ctrl: aliceCtrl, dataKey: LSP3_KEY, dataValue: profileValue, gasLimit: 300000n });
  const y = new ethers.Contract(aliceUp, ['function getData(bytes32) view returns (bytes)'], provider);
  const lsp3now = await y.getData(LSP3_KEY);
  console.log('    alice LSP3 len now:', (lsp3now.length - 2) / 2, 'bytes');
  [ok, reason] = await dist.eligible(aliceUp);
  console.log('    eligible(alice) =', ok, JSON.stringify(reason), '(expect still not-following-dao)');
  out.steps.signalA = { lsp3Len: (lsp3now.length - 2) / 2, eligible: ok, reason };
  if ((lsp3now.length - 2) / 2 === 0) throw new Error('FAIL: LSP3 profile not set');
  if (ok) throw new Error('FAIL: passed gate with no follow yet');
  await guard('signal-a');

  // ---- 4. signal B: alice follows the DAO UP ----
  console.log('\n[4] SIGNAL B: alice follow(daoUP) via LSP26 (relayed UP.execute)');
  const followInner = new ethers.Interface(['function follow(address)']).encodeFunctionData('follow', [daoUp]);
  await relayExec({ provider, relayer, kmAddr: aliceKm, ctrl: aliceCtrl, target: LSP26, innerData: followInner, gasLimit: 300000n });
  const lsp26 = new ethers.Contract(LSP26, ['function isFollowing(address,address) view returns (bool)'], provider);
  const follows = await lsp26.isFollowing(aliceUp, daoUp);
  console.log('    isFollowing(alice -> dao):', follows);
  out.steps.signalB = { follows };
  if (!follows) throw new Error('FAIL: alice follow did not register');
  await guard('signal-b');

  // ---- 5. gate passes -> airdrop ----
  console.log('\n[5] GATE PASSES: eligible(alice) true -> claimFor(alice) mints', N.toString(), 'SOULBOUND');
  [ok, reason] = await dist.eligible(aliceUp);
  console.log('    eligible(alice) =', ok, JSON.stringify(reason));
  if (!ok) throw new Error('FAIL: gate did not pass after both signals');
  await (await dist.claimFor(aliceUp)).wait();
  const aBal = await bal(aliceUp), aSb = await sb(aliceUp);
  console.log('    alice balance', ethers.formatEther(aBal), '| soulbound', ethers.formatEther(aSb));
  out.steps.airdrop = { eligible: ok, balance: aBal.toString(), soulbound: aSb.toString() };
  if (aBal !== N * ONE) throw new Error('FAIL: airdrop amount wrong');
  if (aSb !== N * ONE) throw new Error('FAIL: airdrop not soulbound');
  await guard('airdrop');

  // ---- 6. once per UP ----
  console.log('\n[6] ONCE PER UP: second claimFor(alice) must revert AlreadyClaimed');
  let again = false, aErr = '';
  try { await dist.claimFor.staticCall(aliceUp); } catch (e) { again = true; aErr = e.shortMessage || e.message; }
  console.log('    second claim reverts:', again, aErr ? '| ' + aErr : '');
  out.steps.onceOnly = { reverts: again };
  if (!again) throw new Error('FAIL: second claim was allowed');
  await guard('once-only');

  // ---- 7. negative control: bob still rejected ----
  console.log('\n[7] NEGATIVE CONTROL: bob (bare UP) still rejected');
  const [bok, breason] = await dist.eligible(bobUp);
  console.log('    eligible(bob) =', bok, JSON.stringify(breason));
  out.steps.negativeControl = { eligible: bok, reason: breason };
  if (bok) throw new Error('FAIL: bob (bare) passed the gate');
  await guard('negative-control');

  const totalSpent = Number(ethers.formatEther(startBal - await provider.getBalance(relayer.address)));
  out.verdict = 'PASS';
  out.totalSpentLYX = totalSpent.toFixed(6);
  fs.writeFileSync(path.join(__dirname, 'distributor-e2e-result.json'), JSON.stringify(out, null, 2));
  console.log(`\n✅ VERDICT: PASS — total spent ${totalSpent.toFixed(5)} LYX (cap ${MAX_SPEND_LYX}). token ${tokAddr} dist ${distAddr}`);
  console.log('   wrote distributor-e2e-result.json');
}
main().catch((e) => { console.error('\n❌ DISTRIBUTOR E2E FAILED:', e.shortMessage || e.message || e); process.exit(1); });
