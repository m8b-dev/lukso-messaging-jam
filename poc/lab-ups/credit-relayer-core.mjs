import fs from 'node:fs';
import path from 'node:path';
export class PublicError extends Error { constructor(status, message, extra={}) { super(message); this.status=status; this.extra=extra; } }
export const timeout = (p, ms=15000) => { let t; return Promise.race([p,new Promise((_,reject)=>{t=setTimeout(()=>reject(new PublicError(503,'upstream-timeout')),ms);})]).finally(()=>clearTimeout(t)); };
const address = /^0x[0-9a-fA-F]{40}$/;
export function openLedger(file, cap, identity) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  // Never automatically remove a stale lock: operator must prove the old process is dead.
  const lock=file+'.lock'; const fd=fs.openSync(lock,'wx',0o600); fs.writeFileSync(fd,String(process.pid));
  let poisoned=false;
  let closed=false; const close=()=>{if(closed)return;closed=true;fs.closeSync(fd);fs.unlinkSync(lock);};
  try {
    let state;
    try {state=JSON.parse(fs.readFileSync(file,'utf8'));} catch(e) {if(e.code!=='ENOENT') throw e; state={claimed:{},pending:{},reservedWei:'0',identity,version:1};}
    if(!state || typeof state.claimed!=='object' || !state.claimed || Array.isArray(state.claimed)) throw Error('invalid ledger');
    for(const [up,hash] of Object.entries(state.claimed)) if(!address.test(up)||typeof hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw Error('invalid claim');
    state.claimed=Object.fromEntries(Object.entries(state.claimed).map(([a,h])=>[a.toLowerCase(),h]));
    if(state.version===undefined) {
      // Historical costs are unknowable. Preserve claims and exhaust budget, rather than reset it.
      state={...state,version:1,identity,pending:{},reservedWei:cap.toString(),legacyBudgetUnknown:true};
    }
    if(state.version!==1||state.identity!==identity||!/^[0-9]+$/.test(state.reservedWei)||!state.pending||typeof state.pending!=='object'||Array.isArray(state.pending)) throw Error('invalid ledger metadata');
    for(const [up,p] of Object.entries(state.pending)) if(!address.test(up)||!p||!/^0x[0-9a-fA-F]{64}$/.test(p.txHash)||!/^[0-9]+$/.test(p.maxCostWei)||!Number.isSafeInteger(p.nonce)||p.nonce<0) throw Error('invalid pending');
    if(Object.values(state.pending).reduce((n,p)=>n+BigInt(p.maxCostWei),0n)>BigInt(state.reservedWei)) throw Error('invalid reservation');
    const persist=()=>{
      if(poisoned) throw new PublicError(503,'ledger-unavailable');
      const tmp=file+'.tmp';
      try {const f=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(f,JSON.stringify(state,null,2));fs.fsyncSync(f);}finally{fs.closeSync(f);}fs.renameSync(tmp,file);const d=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}catch(e){poisoned=true;throw new PublicError(503,'ledger-unavailable');}
    };
    persist(); return {state,persist,close,healthy:()=>!poisoned};
  } catch(e) {close();throw e;}
}
export function createClaims({ledger,chain,cap,sendBlockReason=null}) {
  let tail=Promise.resolve(); let queued=0;
  const serial=fn=>{if(queued>=32) return Promise.reject(new PublicError(503,'busy'));queued++;const p=tail.then(fn);tail=p.catch(()=>{}).finally(()=>{queued--;});return p;};
  return up=>serial(async()=>{
    const s=ledger.state; up=up.toLowerCase();
    if(!ledger.healthy()) throw new PublicError(503,'ledger-unavailable');
    // Operator safety interlock precedes all signing, RPC and nonce allocation.
    if(sendBlockReason) throw new PublicError(503,sendBlockReason);
    await timeout(chain.check());
    // Pending transactions block ALL new nonce allocation, even after a restart.
    for(const [who,p] of Object.entries(s.pending)) {
      const receipt=await timeout(chain.receipt(p.txHash));
      if(!receipt) throw new PublicError(503,'transaction-pending',{txHash:p.txHash});
      if(Number(receipt.status)===1) s.claimed[who]=p.txHash;
      else if(Number(receipt.status)!==0) throw new PublicError(503,'receipt-unavailable');
      delete s.pending[who];ledger.persist();
    }
    if(s.claimed[up]) throw new PublicError(409,'already-claimed',{txHash:s.claimed[up]});
    if(s.legacyBudgetUnknown) throw new PublicError(503,'legacy-budget-unknown');
    const g=await timeout(chain.gate(up));if(!g.eligible) throw new PublicError(403,'not-eligible',g);
    const tx=await timeout(chain.prepare(up));const cost=BigInt(tx.maxCostWei);
    if(cost<=0n||BigInt(s.reservedWei)+cost>cap) throw new PublicError(503,'spend-cap-reached');
    s.reservedWei=(BigInt(s.reservedWei)+cost).toString();
    s.pending[up]={txHash:tx.hash,nonce:tx.nonce,maxCostWei:cost.toString()};ledger.persist();
    // Sign locally first; persist hash+nonce+full max-fee reservation BEFORE broadcasting.
    // Any ambiguous send/timeout leaves pending durable. Never retry with a new nonce.
    await timeout(chain.broadcast(tx.raw));
    const receipt=await timeout(chain.wait(tx.hash),45000);
    if(!receipt) throw new PublicError(503,'transaction-pending',{txHash:tx.hash});
    if(Number(receipt.status)===1) s.claimed[up]=tx.hash;
    else if(Number(receipt.status)!==0) throw new PublicError(503,'receipt-unavailable');
    delete s.pending[up];ledger.persist();
    if(Number(receipt.status)!==1) throw new PublicError(503,'transaction-reverted');
    return {txHash:tx.hash,minted:'10'};
  });
}
export function createHandler({chain,claim,origins,info,addrOf}) {
 return async(req,res)=>{
  const origin=req.headers.origin;
  const send=(code,body)=>{if(res.destroyed||res.writableEnded)return;const encoded=code===204?'':JSON.stringify(body);res.writeHead(code,{'content-type':'application/json','content-length':Buffer.byteLength(encoded),'cache-control':'no-store','vary':'Origin',...(origin&&origins.has(origin)?{'access-control-allow-origin':origin,'access-control-allow-headers':'content-type','access-control-allow-methods':'GET, POST, OPTIONS'}:{})});res.end(encoded);};
  try {
   if(origin&&!origins.has(origin)) throw new PublicError(403,'origin-not-allowed');
   if(req.method==='OPTIONS') return send(204,{});
   const u=new URL(req.url,'http://localhost');
   if(req.method==='GET'&&u.pathname==='/health'){await timeout(chain.check());return send(200,{ok:true,...info});}
   if(req.method==='GET'&&['/gate','/balance'].includes(u.pathname)) {const up=addrOf(u.searchParams.get('up'));if(!up)throw new PublicError(400,'bad-up');return send(200,u.pathname==='/gate'?{...await timeout(chain.gate(up)),svcUp:info.svcUp}:await timeout(chain.balances(up)));}
   if(req.method==='POST'&&u.pathname==='/claim') {
    if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')) throw new PublicError(415,'json-required');
    if(Number(req.headers['content-length'])>1024) throw new PublicError(413,'body-too-large');
    const body=await timeout((async()=>{const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>1024)throw new PublicError(413,'body-too-large');chunks.push(c);}return Buffer.concat(chunks).toString('utf8');})(),5000);
    let obj;try{obj=JSON.parse(body);}catch{throw new PublicError(400,'invalid-json');}
    const up=obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).length===1&&typeof obj.up==='string'&&addrOf(obj.up);
    if(!up)throw new PublicError(400,'bad-up');return send(200,await claim(up));
   }
   send(404,{error:'not-found'});
  }catch(e){send(e instanceof PublicError?e.status:503,{error:e instanceof PublicError?e.message:'service-unavailable',...(e instanceof PublicError?e.extra:{})});}
 };
}
