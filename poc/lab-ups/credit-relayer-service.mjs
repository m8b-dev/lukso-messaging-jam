import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { openLedger, createClaims, createHandler, timeout } from './credit-relayer-core.mjs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const require = createRequire(ROOT + '/poc/');
const { ethers } = require('ethers');

const EL = 'https://rpc.mainnet.lukso.network';
const CHAIN_ID = 42;
const LSP25_VERSION = 25;
const KEY_FILE = path.resolve(process.env.CREDIT_RELAYER_KEY_FILE || path.join(os.homedir(), '.openclaw/credentials/credit-relayer.json'));
const realKey = fs.realpathSync(KEY_FILE);
if (realKey === ROOT || realKey.startsWith(ROOT + path.sep)) throw Error('key must be outside repository');
if ((fs.statSync(realKey).mode & 0o077) !== 0) throw Error('key file must be private (0600)');
const TOPO = path.join(__dirname, 'svc-up-topology-e2e-result.json');
const STATE = path.resolve(process.env.CREDIT_RELAYER_STATE_FILE || path.join(__dirname, 'credit-relayer-service-state.json'));
const PORT = Number(process.env.CREDIT_RELAYER_PORT || 8790);
const AIRDROP_AMOUNT = '10';     // credits per claim (matches N=10 decision)
const MAX_SPEND_LYX = process.env.CREDIT_RELAYER_MAX_SPEND_LYX || '0.1';       // hard cap for the whole service lifetime

const LSP3_KEY = '0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5';
const LSP26 = '0xf01103E5a9909Fc0DBe8166dA7085e0285daDDcA';

const KM_ABI = [
  'function getNonce(address signer, uint128 channel) view returns (uint256)',
  'function executeRelayCall(bytes signature, uint256 nonce, uint256 validityTimestamps, bytes payload) payable returns (bytes)',
];
const UP_ABI = ['function execute(uint256 operationType, address target, uint256 value, bytes data) payable returns (bytes)'];
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function soulbound(address) view returns (uint256)',
  'function mint(address to, uint256 amount, bool force, bytes data)',
];
const Y_ABI = ['function getData(bytes32) view returns (bytes)'];

const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function lsp25Digest(km, nonce, validity, value, payload) {
  return ethers.keccak256(ethers.solidityPacked(
    ['bytes1', 'bytes1', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'bytes'],
    ['0x19', '0x00', km, LSP25_VERSION, CHAIN_ID, nonce, validity, value, payload]));
}

const provider = new ethers.JsonRpcProvider(Object.assign(new ethers.FetchRequest(EL), { timeout: 10000 }));
const topo = load(TOPO);
const { svcUp, svcKm, token: tokenAddr } = topo.addresses;
const relayer = new ethers.Wallet(load(realKey).privateKey, provider);
const token = new ethers.Contract(tokenAddr, TOKEN_ABI, provider);
const lsp26 = new ethers.Contract(LSP26, ['function isFollowing(address,address) view returns (bool)'], provider);

async function gate(up) {
  const y = new ethers.Contract(up, Y_ABI, provider);
  const hasLsp3 = ((await y.getData(LSP3_KEY)) || '0x').length > 2;
  const follows = await lsp26.isFollowing(up, svcUp);
  return { hasLsp3, follows, eligible: hasLsp3 && follows };
}

async function balances(up) {
  const [bal, sb] = await Promise.all([token.balanceOf(up), token.soulbound(up)]);
  return {
    balance: ethers.formatEther(bal),
    soulbound: ethers.formatEther(sb),
    free: ethers.formatEther(bal - sb),
  };
}

async function prepare(up, amount = AIRDROP_AMOUNT) {
  const mintInner = new ethers.Interface(TOKEN_ABI).encodeFunctionData(
    'mint', [up, ethers.parseEther(amount), true, '0x']);
  const payload = new ethers.Interface(UP_ABI).encodeFunctionData('execute', [0, tokenAddr, 0n, mintInner]);
  const km = new ethers.Contract(svcKm, KM_ABI, provider);
  const nonce = await km.getNonce(relayer.address, 0n);
  const sig = relayer.signingKey.sign(lsp25Digest(svcKm, nonce, 0n, 0n, payload)).serialized;
  const outer = new ethers.Interface(KM_ABI).encodeFunctionData('executeRelayCall', [sig, nonce, 0n, payload]);
  const fee = await provider.getFeeData();
  if (!fee.maxFeePerGas || fee.maxPriorityFeePerGas == null) throw Error('fee unavailable');
  const nonceEOA = await provider.getTransactionCount(relayer.address, 'pending');
  const request = {to:svcKm,data:outer,type:2,chainId:CHAIN_ID,nonce:nonceEOA,value:0n,
    maxFeePerGas:fee.maxFeePerGas,maxPriorityFeePerGas:fee.maxPriorityFeePerGas,gasLimit:400000n};
  const raw=await relayer.signTransaction(request);
  return {raw,hash:ethers.keccak256(raw),nonce:nonceEOA,maxCostWei:400000n*fee.maxFeePerGas};
}

const cap=ethers.parseEther(MAX_SPEND_LYX);
if(cap<=0n || cap>ethers.parseEther('0.1')) throw Error('invalid spend cap (maximum 0.1 LYX)');
// This deployment shares its EOA with the active blob service. No shared durable
// nonce coordinator exists: read-only is mandatory, not an environment opt-out.
const sendBlockReason='shared-signer-nonce-coordination-required';
const HOST=process.env.CREDIT_RELAYER_HOST||'127.0.0.1';
if(!['127.0.0.1','::1'].includes(HOST)) throw Error('loopback binding required');
const origins=new Set((process.env.CREDIT_RELAYER_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean));
for(const origin of origins) {const u=new URL(origin);if(!['http:','https:'].includes(u.protocol)||u.origin!==origin||origin.includes('*'))throw Error('invalid allowed origin');}
if(!Number.isInteger(PORT)||PORT<1||PORT>65535) throw Error('invalid port');
const chain={
  check:async()=>{if(BigInt(await provider.send('eth_chainId',[]))!==42n)throw Error('wrong chain');},
  gate,balances,prepare,
  broadcast:raw=>provider.broadcastTransaction(raw),
  receipt:async hash=>{const r=await provider.getTransactionReceipt(hash);return r && await r.confirmations()>=2 ? r : null;},
  wait:hash=>provider.waitForTransaction(hash,2,40000),
};
// Explicit RPC check, not a configured/static chain assertion.
await timeout(chain.check());
const ledger=openLedger(STATE,cap,[CHAIN_ID,svcUp,svcKm,tokenAddr,relayer.address].join(':').toLowerCase());
const claim=createClaims({ledger,chain,cap,sendBlockReason});
const server=http.createServer(createHandler({chain,claim,origins,
 info:{svcUp,token:tokenAddr,relayer:relayer.address,chainId:CHAIN_ID,airdrop:AIRDROP_AMOUNT,claimsEnabled:false,claimBlockReason:sendBlockReason},
 addrOf:s=>{try{return ethers.getAddress(s);}catch{return null;}}
}));
server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.timeout=70000;
server.listen(PORT,HOST,()=>console.log('Credit relayer listening; VPN/local testing only'));
// Keep the lock until process exit, including while in-flight requests finish.
process.on('exit',()=>ledger.close());
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),75000).unref();});
