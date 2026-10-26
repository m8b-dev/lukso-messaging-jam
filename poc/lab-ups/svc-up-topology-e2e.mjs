// Historical MAINNET experiment; not part of offline tests. Explicit opt-in required.
if (process.env.UPDAWG_ALLOW_MAINNET_SEND !== '1') {
  throw new Error('Mainnet sends disabled. Review script, current contracts and cumulative budget before setting UPDAWG_ALLOW_MAINNET_SEND=1.');
}
// svc-up-topology-e2e.mjs — "JUST UP" ownership topology on LUKSO MAINNET.
// TEST NAMES only (TCRED / LSP3 name "dawgtestup"). NOT final branding, NOT a
// production deploy — a mainnet proof of the DAO-less topology B chose:
//
//   A dedicated SERVICE UP ("dawgtestup") — NOT alice, NOT B's personal UP —
//   owns everything. Its LSP6 KeyManager is the mint authority and the vault
//   owner. No DAO contract, no vote-executor, no scoped-role matrix: authority
//   lives directly on the one UP, exercised via relayed UP.execute.
//
// Controller: a FRESH EOA saved to .svc-up-key.json (1b — new key, isolated).
//
// Steps (each verified on real chain):
//   0. make/load the fresh svc controller EOA; fund it for gas from z/relayer.
//   1. deploy service UP + KeyManager via LSP23 (ALL_PERMISSIONS to svc ctrl).
//   2. set the service UP's LSP3 profile name = "dawgtestup" (relayed setData).
//   3. deploy credit token with owner_ = SERVICE UP's KeyManager (the token's
//      documented intent: mint() gated by the control UP). deploy LSP9 vault
//      (owner = relayer EOA initially), then hand vault -> service UP (LSP14
//      2-step, relayed acceptOwnership through the svc KM). set token.treasury
//      = vault (relayed setData is not it — setTreasury is onlyOwner on the
//      token, owner is the KM, so relay UP.execute(CALL, token, setTreasury)).
//   4. GATE-CHECKED RELAYED MINT: off-chain gate (eligible via the Distributor
//      oracle OR direct LSP3+LSP26 reads) passes for alice; then the SERVICE UP
//      mints 10 soulbound credits to alice by relaying UP.execute(CALL, token,
//      mint(alice,10,true,"")). Mint authority is literally the UP's KeyManager.
//   5. GOVERNED VAULT MOVE: service UP relays UP.execute(CALL, vault,
//      vault.execute(CALL, relayer, 0.002)) — treasury payout driven only by the
//      service UP. (seed vault with 0.01 LYX first.)
//   6. NEGATIVE CONTROLS: (a) alice UP tries to mint -> fails (not token owner);
//      (b) alice UP tries to move the vault -> fails (not vault owner). The
//      service UP is the sole authority.
//
// SPEND GUARD hard cap 1.5 LYX (task cap 2). Reuses the live soulbound token
// code (contracts/dao/DawgToken.sol) + lab alice UP as the recipient user.

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
const SVC_KEYFILE = path.join(KEYDIR, '.svc-up-key.json');
const STATEFILE = path.join(__dirname, 'state.json');
const MAX_SPEND_LYX = 1.5;
const TOKEN_CAP = ethers.parseEther('1000000');
const N = 10n;

// --- canonical LUKSO infra (same as deploy-ups.js) ---
const LSP23_FACTORY = '0x2300000A84D25dF63081feAa37ba6b62C4c89a30';
const UP_POST_DEPLOY_INIT = '0x000000000066093407b6704B89793beFfD0D8F00';
const UP_INIT = '0x3024D38EA2434BA6635003Dc1BDC0daB5882ED4F';
const KM_INIT = '0x2Fe3AeD98684E7351aD2D408A43cE09a738BF8a4';
const ALL_PERMISSIONS = '0x00000000000000000000000000000000000000000000000000000000007f3f7f';
const AP_ARRAY_LENGTH = '0xdf30dba06db6a30e65354d9a64c609861f089545ca58c6b4dbe31a5f338cb0e3';
const AP_ARRAY_INDEX_PREFIX = '0xdf30dba06db6a30e65354d9a64c6098600000000000000000000000000000000';
const AP_PERMISSIONS_PREFIX = '0x4b80742de2bf82acb3630000';

const LSP3_KEY = '0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5';
const LSP26 = '0xf01103E5a9909Fc0DBe8166dA7085e0285daDDcA';

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const V = (n) => ethers.parseEther(n);

// ---- compile the token (frontend2/node_modules import resolver) ----
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
function vaultArtifact() {
  const art = require(path.join(NM, '@lukso/lsp9-contracts/artifacts/LSP9Vault.json'));
  return { abi: art.abi, bytecode: art.bytecode };
}

// ---- ABIs ----
const KM_ABI = [
  'function getNonce(address signer, uint128 channel) view returns (uint256)',
  'function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)',
];
const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const SETDATA_ABI = ['function setData(bytes32 dataKey, bytes dataValue)'];
const FACTORY_ABI = [
  'function computeERC1167Addresses((bytes32 salt,uint256 fundingAmount,address implementationContract,bytes initializationCalldata) primary,(uint256 fundingAmount,address implementationContract,bytes initializationCalldata,bool addPrimaryContractAddress,bytes extraInitializationParams) secondary,address postDeploymentModule,bytes postDeploymentCalldata) view returns (address,address)',
  'function deployERC1167Proxies((bytes32 salt,uint256 fundingAmount,address implementationContract,bytes initializationCalldata) primary,(uint256 fundingAmount,address implementationContract,bytes initializationCalldata,bool addPrimaryContractAddress,bytes extraInitializationParams) secondary,address postDeploymentModule,bytes postDeploymentCalldata) payable returns (address,address)',
];
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
  'function owner() view returns (address)',
  'function treasury() view returns (address)',
  'function mint(address to, uint256 amount, bool force, bytes data)',
  'function setTreasury(address t)',
];

function lsp25Digest(km, nonce, validity, value, payload) {
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', km, LSP25_VERSION, CHAIN_ID, nonce, validity, value, payload]));
}
// Relay an already-encoded KeyManager payload, signed by ctrl, gas paid by sender.
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
// UP.execute(CALL, target, value, innerData) via the KeyManager.
async function relayUpExecute({ provider, sender, kmAddr, ctrl, target, value, innerData, gasLimit }) {
  const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, target, value, innerData]);
  return relayPayload({ provider, sender, kmAddr, ctrl, payload, gasLimit });
}
// Direct setData on the KeyManager (SETDATA permission).
async function relaySetData({ provider, sender, kmAddr, ctrl, dataKey, dataValue, gasLimit }) {
  const payload = new ethers.Interface(SETDATA_ABI).encodeFunctionData('setData', [dataKey, dataValue]);
  return relayPayload({ provider, sender, kmAddr, ctrl, payload, gasLimit });
}

function buildSetData(controllerAddr) {
  const ctrl = controllerAddr.toLowerCase().substring(2);
  const keys = [AP_ARRAY_LENGTH, AP_ARRAY_INDEX_PREFIX, AP_PERMISSIONS_PREFIX + ctrl];
  const values = [ethers.toBeHex(1, 16), controllerAddr, ALL_PERMISSIONS];
  return new ethers.AbiCoder().encode(['bytes32[]', 'bytes[]'], [keys, values]);
}

async function deploySvcUp(provider, svcCtrl, state) {
  const upIface = new ethers.Interface(['function initialize(address initialOwner)']);
  const kmIface = new ethers.Interface(['function initialize(address target)']);
  const factory = new ethers.Contract(LSP23_FACTORY, FACTORY_ABI, svcCtrl);
  const salt = state.salt || ethers.hexlify(ethers.randomBytes(32));
  state.salt = salt;
  const primary = { salt, fundingAmount: 0, implementationContract: UP_INIT,
    initializationCalldata: upIface.encodeFunctionData('initialize', [UP_POST_DEPLOY_INIT]) };
  const secondary = { fundingAmount: 0, implementationContract: KM_INIT,
    initializationCalldata: kmIface.getFunction('initialize').selector,
    addPrimaryContractAddress: true, extraInitializationParams: '0x' };
  const setData = buildSetData(svcCtrl.address);
  const [upAddr, kmAddr] = await factory.computeERC1167Addresses(primary, secondary, UP_POST_DEPLOY_INIT, setData);
  state.upAddress = upAddr; state.kmAddress = kmAddr;
  if (!state.deployTx) {
    const fee = await provider.getFeeData();
    const tx = await factory.deployERC1167Proxies(primary, secondary, UP_POST_DEPLOY_INIT, setData,
      { gasLimit: 1_200_000n, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas });
    const r = await tx.wait();
    state.deployTx = r.hash;
  }
  const code = await provider.getCode(upAddr);
  if (!code || code === '0x') throw new Error('svc UP has no code at ' + upAddr);
  return state;
}

async function main() {
  console.log('=== E2E: "JUST UP" ownership topology (service UP owns token+vault) — LUKSO MAINNET ===\n');
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  if ((await provider.getNetwork()).chainId !== BigInt(CHAIN_ID)) throw new Error('wrong chain');

  const relayer = new ethers.Wallet(load(path.join(KEYDIR, '.z-lukso-key.json')).privateKey, provider);
  const st = load(STATEFILE);
  const aliceUp = ethers.getAddress(st.alice.upAddress), aliceKm = ethers.getAddress(st.alice.kmAddress);
  const aliceCtrl = new ethers.Wallet(load(path.join(KEYDIR, '.lab-alice-key.json')).privateKey);

  // ---- 0. fresh svc controller EOA (1b) ----
  let svcKey;
  if (fs.existsSync(SVC_KEYFILE)) {
    svcKey = load(SVC_KEYFILE);
    console.log('[0] svc controller EOA (existing):', svcKey.address);
  } else {
    const w = ethers.Wallet.createRandom();
    svcKey = { address: w.address, privateKey: w.privateKey, note: 'dawgtestup service UP controller — TEST, not production' };
    fs.writeFileSync(SVC_KEYFILE, JSON.stringify(svcKey, null, 2), { mode: 0o600 });
    console.log('[0] svc controller EOA (NEW, saved to .svc-up-key.json):', svcKey.address);
  }
  const svcCtrl = new ethers.Wallet(svcKey.privateKey, provider);

  const startBal = await provider.getBalance(relayer.address);
  const guard = async (label) => {
    const lyx = Number(ethers.formatEther(startBal - await provider.getBalance(relayer.address)));
    console.log(`    [spend so far: ${lyx.toFixed(5)} LYX]`);
    if (lyx > MAX_SPEND_LYX) throw new Error(`SPEND GUARD: ${lyx} > ${MAX_SPEND_LYX} at ${label}`);
  };
  console.log('relayer/funder:', relayer.address, ethers.formatEther(startBal), 'LYX');
  console.log('svc ctrl      :', svcCtrl.address);
  console.log('user (alice)  :', aliceUp, 'km', aliceKm, '\n');

  const out = { network: 'lukso-mainnet', topology: 'service-UP-owns-token+vault', tokenNames: { name: 'Test Credit', symbol: 'TCRED' }, lsp3Name: 'dawgtestup', steps: {} };

  // fund svc ctrl for its own LSP23 deploy tx (it sends it, pays gas)
  const svcBal = await provider.getBalance(svcCtrl.address);
  if (svcBal < V('0.03')) {
    await (await relayer.sendTransaction({ to: svcCtrl.address, value: V('0.03') - svcBal, gasLimit: 21000n })).wait();
  }
  await guard('fund-svc-ctrl');

  // ---- 1. deploy service UP + KM via LSP23 ----
  console.log('[1] deploy service UP + KeyManager via LSP23 (ALL_PERMISSIONS -> svc ctrl)');
  st.svc = st.svc || { controller: svcCtrl.address };
  st.svc = await deploySvcUp(provider, svcCtrl, st.svc);
  fs.writeFileSync(STATEFILE, JSON.stringify(st, null, 2));
  const svcUp = ethers.getAddress(st.svc.upAddress), svcKm = ethers.getAddress(st.svc.kmAddress);
  console.log('    service UP:', svcUp, '| KM:', svcKm);
  out.steps.deployUp = { svcUp, svcKm, controller: svcCtrl.address, deployTx: st.svc.deployTx };
  await guard('deploy-up');

  // ---- 2. set LSP3 profile name = "dawgtestup" ----
  console.log('\n[2] set service UP LSP3 name = "dawgtestup" (relayed setData)');
  // Minimal VerifiableURI pointing at an inline data: JSON {name:"dawgtestup"}.
  // Format: 0x0000 (verifiableURI) + 6f357c6a (keccak256 method id prefix 'keccak256(utf8)') + 0020 (32-byte hash len)
  //         + 32-byte hash of the JSON + the URL bytes. The gate only needs non-empty + a readable name.
  const profileJson = JSON.stringify({ LSP3Profile: { name: 'dawgtestup', description: 'UP Dawg service UP (TEST)', links: [], tags: ['test'] } });
  const jsonBytes = ethers.toUtf8Bytes(profileJson);
  const jsonHash = ethers.keccak256(jsonBytes);
  const dataUrl = 'data:application/json;base64,' + Buffer.from(profileJson).toString('base64');
  const urlBytes = ethers.hexlify(ethers.toUtf8Bytes(dataUrl)).slice(2);
  const lsp3Value = '0x0000' + '6f357c6a' + '0020' + jsonHash.slice(2) + urlBytes;
  await relaySetData({ provider, sender: relayer, kmAddr: svcKm, ctrl: svcCtrl, dataKey: LSP3_KEY, dataValue: lsp3Value, gasLimit: 400000n });
  const y = new ethers.Contract(svcUp, ['function getData(bytes32) view returns (bytes)'], provider);
  const lsp3now = await y.getData(LSP3_KEY);
  console.log('    LSP3 len now:', (lsp3now.length - 2) / 2, 'bytes (name embedded: dawgtestup)');
  out.steps.lsp3 = { len: (lsp3now.length - 2) / 2, name: 'dawgtestup' };
  if ((lsp3now.length - 2) / 2 === 0) throw new Error('FAIL: LSP3 not set');
  await guard('lsp3');

  // ---- 3. deploy token (owner = service UP KM) + vault (owned by service UP) ----
  console.log('\n[3] deploy token (owner = service UP KM) + vault (hand to service UP), set token.treasury=vault');
  // owner_ = the SERVICE UP itself (not its KeyManager): ERC725X CALLs made via
  // UP.execute originate from the UP address, so onlyOwner must see msg.sender ==
  // svcUp. The UP's own authority is in turn gated by its KeyManager (relayed).
  const tk = compile(TOKEN_SRC, 'DawgToken');
  const token = await new ethers.ContractFactory(tk.abi, tk.bytecode, relayer).deploy('Test Credit', 'TCRED', svcUp, TOKEN_CAP);
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log('    token:', tokenAddr, '| owner (== svc UP):', ethers.getAddress(await token.owner()) === svcUp);
  if (ethers.getAddress(await token.owner()) !== svcUp) throw new Error('FAIL: token owner is not service UP');

  const { abi: VABI, bytecode: VBYTE } = vaultArtifact();
  const vault = await new ethers.ContractFactory(VABI, VBYTE, relayer).deploy(relayer.address);
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  await (await vault.transferOwnership(svcUp)).wait();
  const vaultIface = new ethers.Interface(VAULT_ABI);
  await relayUpExecute({ provider, sender: relayer, kmAddr: svcKm, ctrl: svcCtrl, target: vaultAddr, value: 0n,
    innerData: vaultIface.encodeFunctionData('acceptOwnership', []), gasLimit: 400000n });
  const vaultOwner = await vault.owner();
  console.log('    vault:', vaultAddr, '| owner (== svc UP):', ethers.getAddress(vaultOwner) === svcUp);
  if (ethers.getAddress(vaultOwner) !== svcUp) throw new Error('FAIL: vault owner is not service UP');

  // token.setTreasury(vault) — onlyOwner (owner = svc KM) -> relay UP.execute(CALL, token, setTreasury(vault))
  const setTreasuryInner = new ethers.Interface(TOKEN_ABI).encodeFunctionData('setTreasury', [vaultAddr]);
  await relayUpExecute({ provider, sender: relayer, kmAddr: svcKm, ctrl: svcCtrl, target: tokenAddr, value: 0n, innerData: setTreasuryInner, gasLimit: 300000n });
  const tre = await token.treasury();
  console.log('    token.treasury -> vault:', ethers.getAddress(tre) === ethers.getAddress(vaultAddr));
  if (ethers.getAddress(tre) !== ethers.getAddress(vaultAddr)) throw new Error('FAIL: setTreasury not applied');
  out.steps.deployOwned = { token: tokenAddr, tokenOwnerIsSvcUp: true, vault: vaultAddr, vaultOwnerIsSvcUp: true, treasuryIsVault: true };
  await guard('deploy-owned');

  const bal = (a) => token.balanceOf(a);
  const sb = (a) => token.soulbound(a);
  const lyxOf = (a) => provider.getBalance(a);

  // ---- 4. gate-checked relayed MINT through the service UP ----
  console.log('\n[4] gate check (LSP3 + LSP26 follow) then SERVICE UP mints 10 soulbound to alice (relayed UP.execute -> token.mint)');
  // ensure alice satisfies the off-chain gate: LSP3 present + follows the service UP.
  const lsp26 = new ethers.Contract(LSP26, ['function isFollowing(address,address) view returns (bool)', 'function follow(address)'], provider);
  const aliceY = new ethers.Contract(aliceUp, ['function getData(bytes32) view returns (bytes)'], provider);
  const aliceHasLsp3 = (await aliceY.getData(LSP3_KEY)).length > 2;
  let follows = await lsp26.isFollowing(aliceUp, svcUp);
  console.log('    gate: alice LSP3?', aliceHasLsp3, '| alice follows svc UP?', follows);
  if (!follows) {
    // make alice follow the service UP so the gate genuinely passes (relayed via alice KM)
    const followInner = new ethers.Interface(['function follow(address)']).encodeFunctionData('follow', [svcUp]);
    await relayUpExecute({ provider, sender: relayer, kmAddr: aliceKm, ctrl: aliceCtrl, target: LSP26, value: 0n, innerData: followInner, gasLimit: 300000n });
    follows = await lsp26.isFollowing(aliceUp, svcUp);
    console.log('    alice now follows svc UP:', follows);
  }
  const gateOk = aliceHasLsp3 && follows;
  if (!gateOk) throw new Error('FAIL: off-chain gate did not pass (need LSP3 + follow)');

  const aBalBefore = await bal(aliceUp);
  const mintInner = new ethers.Interface(TOKEN_ABI).encodeFunctionData('mint', [aliceUp, N * V('1'), true, '0x']);
  await relayUpExecute({ provider, sender: relayer, kmAddr: svcKm, ctrl: svcCtrl, target: tokenAddr, value: 0n, innerData: mintInner, gasLimit: 400000n });
  const aBal = await bal(aliceUp), aSb = await sb(aliceUp);
  console.log('    alice credit', ethers.formatEther(aBalBefore), '->', ethers.formatEther(aBal), '| soulbound', ethers.formatEther(aSb));
  out.steps.mintThroughUp = { gateOk, before: aBalBefore.toString(), after: aBal.toString(), soulbound: aSb.toString() };
  if (aBal !== aBalBefore + N * V('1')) throw new Error('FAIL: mint through UP did not credit alice');
  if (aSb < N * V('1')) throw new Error('FAIL: minted credit not soulbound');
  await guard('mint-through-up');

  // ---- 5. governed vault move ----
  console.log('\n[5] seed vault 0.01 LYX, then GOVERNED move: svc UP -> vault.execute(CALL, relayer, 0.002)');
  await (await relayer.sendTransaction({ to: vaultAddr, value: V('0.01') })).wait();
  const vBefore = await lyxOf(vaultAddr);
  const innerVaultExec = vaultIface.encodeFunctionData('execute', [0, relayer.address, V('0.002'), '0x']);
  await relayUpExecute({ provider, sender: relayer, kmAddr: svcKm, ctrl: svcCtrl, target: vaultAddr, value: 0n, innerData: innerVaultExec, gasLimit: 500000n });
  const vAfter = await lyxOf(vaultAddr);
  console.log('    vault LYX', ethers.formatEther(vBefore), '->', ethers.formatEther(vAfter));
  out.steps.governedVaultMove = { before: vBefore.toString(), after: vAfter.toString(), ok: vAfter === vBefore - V('0.002') };
  if (vAfter !== vBefore - V('0.002')) throw new Error('FAIL: governed vault move did not debit vault');
  await guard('governed-vault-move');

  // ---- 6. NEGATIVE CONTROLS: alice UP cannot mint and cannot move the vault ----
  console.log('\n[6] NEGATIVE: alice UP tries to (a) mint and (b) move the vault — both must fail');
  // (a) alice relays UP.execute(CALL, token, mint(alice, 1)) -> token onlyOwner reverts (owner = svc KM)
  const beforeA = await bal(aliceUp);
  const aliceMint = new ethers.Interface(TOKEN_ABI).encodeFunctionData('mint', [aliceUp, V('1'), true, '0x']);
  let mintBlocked = false, mErr = '';
  try {
    const r = await relayUpExecute({ provider, sender: relayer, kmAddr: aliceKm, ctrl: aliceCtrl, target: tokenAddr, value: 0n, innerData: aliceMint, gasLimit: 400000n });
    mintBlocked = r.status === 0;
  } catch (e) { mintBlocked = true; mErr = e.shortMessage || e.message; }
  const afterA = await bal(aliceUp);
  const mintUnchanged = afterA === beforeA;
  console.log('    (a) alice mint blocked:', mintBlocked, '| alice credit unchanged:', mintUnchanged, mErr ? '| ' + mErr : '');

  // (b) alice relays UP.execute(CALL, vault, vault.execute(CALL, alice, 0.002)) -> vault onlyOwner reverts
  const beforeB = await lyxOf(vaultAddr);
  const aliceGrab = vaultIface.encodeFunctionData('execute', [0, aliceUp, V('0.002'), '0x']);
  let vaultBlocked = false, vErr = '';
  try {
    const r = await relayUpExecute({ provider, sender: relayer, kmAddr: aliceKm, ctrl: aliceCtrl, target: vaultAddr, value: 0n, innerData: aliceGrab, gasLimit: 500000n });
    vaultBlocked = r.status === 0;
  } catch (e) { vaultBlocked = true; vErr = e.shortMessage || e.message; }
  const afterB = await lyxOf(vaultAddr);
  const vaultUnchanged = afterB === beforeB;
  console.log('    (b) alice vault move blocked:', vaultBlocked, '| vault LYX unchanged:', vaultUnchanged, vErr ? '| ' + vErr : '');
  out.steps.negative = { mintBlocked: mintBlocked || mintUnchanged, mintUnchanged, vaultBlocked: vaultBlocked || vaultUnchanged, vaultUnchanged };
  if (!(mintBlocked || mintUnchanged)) throw new Error('FAIL: alice minted (not token owner!)');
  if (!(vaultBlocked || vaultUnchanged)) throw new Error('FAIL: alice drained the vault (not vault owner!)');
  await guard('negative');

  const totalSpent = Number(ethers.formatEther(startBal - await provider.getBalance(relayer.address)));
  out.verdict = 'PASS';
  out.totalSpentLYX = totalSpent.toFixed(6);
  out.addresses = { svcUp, svcKm, svcController: svcCtrl.address, token: tokenAddr, vault: vaultAddr };
  fs.writeFileSync(path.join(__dirname, 'svc-up-topology-e2e-result.json'), JSON.stringify(out, null, 2));
  console.log(`\n✅ VERDICT: PASS — service UP "dawgtestup" is the sole authority over token + vault. spend ${totalSpent.toFixed(5)} LYX (cap ${MAX_SPEND_LYX}).`);
  console.log('   svc UP', svcUp, '| token', tokenAddr, '| vault', vaultAddr);
  console.log('   wrote svc-up-topology-e2e-result.json');
}
main().catch((e) => { console.error('\n❌ SVC-UP TOPOLOGY E2E FAILED:', e.shortMessage || e.message || e); process.exit(1); });
