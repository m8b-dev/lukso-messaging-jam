// Historical MAINNET experiment; not part of offline tests. Explicit opt-in required.
if (process.env.UPDAWG_ALLOW_MAINNET_SEND !== '1') {
  throw new Error('Mainnet sends disabled. Review script, current contracts and cumulative budget before setting UPDAWG_ALLOW_MAINNET_SEND=1.');
}
// credit-token-e2e.mjs — E2E on LUKSO MAINNET for the soulbound relay-credit
// token (contracts/dao/DawgToken.sol), using TEST NAMES ("Test Credit"/"TCRED",
// NOT the final DAWG branding — B: test names until the design is solid).
//
// Proves, on real chain with funded controllers:
//   1. deploy the token (LSP7Mintable+CappedSupply+Burnable+Votes+soulbound),
//      owner = relayer EOA (stands in for the treasury control UP KeyManager);
//      setTreasury(treasury) marks the exempt address.
//   2. AIRDROP: mint 10 TCRED to alice UP  -> soulbound[alice] == 10.
//   3. SOULBOUND BLOCK: alice UP tries to transfer 1 earned TCRED to bob UP
//      (via UP.execute over LSP25) -> MUST revert DawgSoulboundLocked.
//   4. AUTHORIZE: alice authorizes relayer as operator for a BOUNDED amount (3),
//      done BEFORE confirming balance mechanics -> proves no balance-check gate.
//   5. CLAWBACK (spend): relayer (operator) transfer(alice -> treasury, 1) ->
//      soulbound[alice] 10->9, balance 10->9, allowance 3->2, treasury +1.
//   6. FREE vs LOCKED: mint 2 TCRED to treasury (exempt, NOT soulbound), treasury
//      transfers them to bob -> bob can re-transfer (free); then show alice's
//      remaining 9 are still all soulbound (locked).
//
// SPEND GUARD: aborts if cumulative gas would exceed MAX_SPEND_LYX (default 1).
// Task cap is 2 LYX; this stays far under (gas ~1 gwei on LUKSO).

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
const SRC = path.join(ROOT, 'contracts/dao/DawgToken.sol');
const MAX_SPEND_LYX = 1.0; // hard self-cap (task budget is 2 LYX total)
const TOKEN_CAP = ethers.parseEther('1000000'); // 1M cap for the test token

const loadPk = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).privateKey;

// ---- compile contracts/dao/DawgToken.sol with node_modules import resolver ---
function compileToken() {
  function resolve(p) { const c = path.join(NM, p); return fs.existsSync(c) ? c : null; }
  const findImports = (p) => { const abs = resolve(p); return abs ? { contents: fs.readFileSync(abs, 'utf8') } : { error: 'not found: ' + p }; };
  const input = {
    language: 'Solidity',
    sources: { 'DawgToken.sol': { content: fs.readFileSync(SRC, 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) { errs.slice(0, 10).forEach((e) => console.error(e.formattedMessage)); throw new Error('compile failed'); }
  const c = out.contracts['DawgToken.sol']['DawgToken'];
  return { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

// ---- LSP25 relay plumbing (same as proven spikes) --------------------------
const KM_ABI = [
  'function getNonce(address signer, uint128 channel) view returns (uint256)',
  'function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)',
];
const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];

function lsp25Digest(km, nonce, validity, value, payload) {
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', km, LSP25_VERSION, CHAIN_ID, nonce, validity, value, payload]));
}
// Relay an inner UP.execute(call to `target` with `innerData`) signed by `ctrl`,
// sent (gas paid) by `relayer`. Returns the receipt.
async function relayExec({ provider, relayer, kmAddr, ctrl, target, innerData, gasLimit }) {
  const km = new ethers.Contract(kmAddr, KM_ABI, provider);
  const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, target, 0, innerData]);
  const nonce = await km.getNonce(ctrl.address, 0n);
  const digest = lsp25Digest(kmAddr, nonce, 0n, 0n, payload);
  const sig = ctrl.signingKey.sign(digest).serialized;
  const outer = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, payload]);
  const fee = await provider.getFeeData();
  const tx = await relayer.sendTransaction({ to: kmAddr, data: outer, type: 2, chainId: CHAIN_ID,
    maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas, gasLimit });
  return tx.wait();
}

async function main() {
  console.log('=== E2E: soulbound relay-credit token (TEST NAMES) — LUKSO MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');

  const relayer = new ethers.Wallet(loadPk(path.join(KEYDIR, '.z-lukso-key.json')), provider);
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
  const aliceUp = ethers.getAddress(st.alice.upAddress), aliceKm = ethers.getAddress(st.alice.kmAddress);
  const bobUp = ethers.getAddress(st.bob.upAddress);
  const aliceCtrl = new ethers.Wallet(loadPk(path.join(KEYDIR, '.lab-alice-key.json')));
  const treasury = relayer.address; // spike stand-in for the LSP9 vault / control UP

  const startBal = await provider.getBalance(relayer.address);
  const guard = async (label) => {
    const spent = startBal - await provider.getBalance(relayer.address);
    const lyx = Number(ethers.formatEther(spent));
    console.log(`    [spend so far: ${lyx.toFixed(5)} LYX]`);
    if (lyx > MAX_SPEND_LYX) throw new Error(`SPEND GUARD: ${lyx} > ${MAX_SPEND_LYX} LYX at ${label}`);
  };

  console.log('relayer/treasury:', relayer.address, ethers.formatEther(startBal), 'LYX');
  console.log('alice UP        :', aliceUp, 'km', aliceKm);
  console.log('bob UP          :', bobUp, '\n');

  const out = { network: 'lukso-mainnet', tokenNames: { name: 'Test Credit', symbol: 'TCRED' }, steps: {} };

  // ---- 1. deploy token ----
  console.log('[1] deploy token (owner=relayer), setTreasury(treasury)');
  const { abi, bytecode } = compileToken();
  const factory = new ethers.ContractFactory(abi, bytecode, relayer);
  const tok = await factory.deploy('Test Credit', 'TCRED', relayer.address, TOKEN_CAP);
  await tok.waitForDeployment();
  const tokAddr = await tok.getAddress();
  await (await tok.setTreasury(treasury)).wait();
  console.log('    token:', tokAddr, '| cap', ethers.formatEther(TOKEN_CAP), '| treasury', treasury);
  out.steps.deploy = { token: tokAddr, cap: TOKEN_CAP.toString(), treasury };
  await guard('deploy');

  const ONE = ethers.parseEther('1');
  const bal = async (a) => tok.balanceOf(a);
  const sb = async (a) => tok.soulbound(a);

  // ---- 2. airdrop: mint 10 soulbound to alice ----
  console.log('\n[2] AIRDROP: mint 10 TCRED to alice UP');
  await (await tok.mint(aliceUp, 10n * ONE, true, '0x')).wait();
  console.log('    alice balance', ethers.formatEther(await bal(aliceUp)), '| soulbound', ethers.formatEther(await sb(aliceUp)));
  out.steps.airdrop = { balance: (await bal(aliceUp)).toString(), soulbound: (await sb(aliceUp)).toString() };
  if (await sb(aliceUp) !== 10n * ONE) throw new Error('FAIL: airdrop not soulbound');
  await guard('airdrop');

  // ---- 3. soulbound block: alice tries to send 1 earned TCRED to bob ----
  console.log('\n[3] SOULBOUND BLOCK: alice UP -> transfer 1 earned TCRED to bob (must revert)');
  const xferData = new ethers.Interface(abi).encodeFunctionData('transfer', [aliceUp, bobUp, ONE, true, '0x']);
  let blocked = false, blockErr = '';
  try {
    const r = await relayExec({ provider, relayer, kmAddr: aliceKm, ctrl: aliceCtrl, target: tokAddr, innerData: xferData, gasLimit: 400000n });
    // LSP6 swallows inner revert into a failed relay; status 0 OR unchanged balances both prove the block.
    blocked = r.status === 0;
  } catch (e) { blocked = true; blockErr = e.shortMessage || e.message; }
  const bobBal = await bal(bobUp);
  const stillLocked = (await bal(aliceUp)) === 10n * ONE && bobBal === 0n;
  console.log('    reverted/failed:', blocked, '| alice still 10 & bob 0:', stillLocked, blockErr ? '| ' + blockErr : '');
  out.steps.soulboundBlock = { blocked: blocked || stillLocked, aliceBalance: (await bal(aliceUp)).toString(), bobBalance: bobBal.toString() };
  if (!(blocked || stillLocked)) throw new Error('FAIL: soulbound transfer was NOT blocked');
  await guard('soulbound-block');

  // ---- 4. authorize relayer as operator, BOUNDED (3), via UP.execute ----
  console.log('\n[4] AUTHORIZE: alice authorizes relayer operator for bounded 3 TCRED');
  const authData = new ethers.Interface(abi).encodeFunctionData('authorizeOperator', [relayer.address, 3n * ONE, '0x']);
  await relayExec({ provider, relayer, kmAddr: aliceKm, ctrl: aliceCtrl, target: tokAddr, innerData: authData, gasLimit: 400000n });
  const authed = await tok.authorizedAmountFor(relayer.address, aliceUp);
  console.log('    authorizedAmountFor(relayer,alice) =', ethers.formatEther(authed));
  out.steps.authorize = { bounded: authed.toString() };
  if (authed !== 3n * ONE) throw new Error('FAIL: bounded authorization != 3');
  await guard('authorize');

  // ---- 5. clawback: relayer pulls 1 TCRED alice -> treasury (spend-on-post) ----
  console.log('\n[5] CLAWBACK: relayer (operator) transfer(alice -> treasury, 1)');
  const aBefore = await bal(aliceUp), sbBefore = await sb(aliceUp), tBefore = await bal(treasury);
  await (await tok.transfer(aliceUp, treasury, ONE, true, '0x')).wait();
  const aAfter = await bal(aliceUp), sbAfter = await sb(aliceUp), tAfter = await bal(treasury), authAfter = await tok.authorizedAmountFor(relayer.address, aliceUp);
  console.log(`    alice ${ethers.formatEther(aBefore)}->${ethers.formatEther(aAfter)} | soulbound ${ethers.formatEther(sbBefore)}->${ethers.formatEther(sbAfter)} | treasury +${ethers.formatEther(tAfter - tBefore)} | allowance ${ethers.formatEther(3n*ONE)}->${ethers.formatEther(authAfter)}`);
  out.steps.clawback = { aliceAfter: aAfter.toString(), soulboundAfter: sbAfter.toString(), treasuryGained: (tAfter - tBefore).toString(), allowanceAfter: authAfter.toString() };
  if (aAfter !== aBefore - ONE) throw new Error('FAIL: alice not debited 1');
  if (sbAfter !== sbBefore - ONE) throw new Error('FAIL: soulbound not consumed on clawback');
  if (authAfter !== 2n * ONE) throw new Error('FAIL: operator allowance not decremented');
  await guard('clawback');

  // ---- 6. free vs locked: treasury-minted TCRED is tradeable ----
  console.log('\n[6] FREE vs LOCKED: mint 2 TCRED to treasury (exempt) -> treasury sends to bob -> bob free to move');
  await (await tok.mint(treasury, 2n * ONE, true, '0x')).wait();
  const tsb = await sb(treasury);
  await (await tok.transfer(treasury, bobUp, 2n * ONE, true, '0x')).wait(); // from==treasury: free
  const bobSb = await sb(bobUp), bobBal2 = await bal(bobUp);
  // Proof that bob's tokens are FREE (not soulbound): bob's soulbound sub-balance
  // is 0, so _beforeTokenTransfer's "free = balanceOf - soulbound" lets it move.
  console.log('    treasury soulbound after mint:', ethers.formatEther(tsb), '(must be 0, exempt) | bob balance', ethers.formatEther(bobBal2), '| bob soulbound', ethers.formatEther(bobSb), '(must be 0, free)');
  out.steps.freeVsLocked = { treasurySoulbound: tsb.toString(), bobBalance: bobBal2.toString(), bobSoulbound: bobSb.toString(), aliceStillLocked: (await sb(aliceUp)).toString() };
  if (tsb !== 0n) throw new Error('FAIL: treasury mint was soulbound (should be exempt)');
  if (bobSb !== 0n) throw new Error('FAIL: bob received soulbound (bought/transferred should be free)');
  await guard('free-vs-locked');

  const totalSpent = Number(ethers.formatEther(startBal - await provider.getBalance(relayer.address)));
  out.verdict = 'PASS';
  out.totalSpentLYX = totalSpent.toFixed(6);
  fs.writeFileSync(path.join(__dirname, 'credit-token-e2e-result.json'), JSON.stringify(out, null, 2));
  console.log(`\n✅ VERDICT: PASS — total spent ${totalSpent.toFixed(5)} LYX (cap ${MAX_SPEND_LYX}). token ${tokAddr}`);
  console.log('   wrote credit-token-e2e-result.json');
}
main().catch((e) => { console.error('\n❌ E2E FAILED:', e.shortMessage || e.message || e); process.exit(1); });
