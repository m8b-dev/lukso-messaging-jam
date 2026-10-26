import assert from 'node:assert/strict';
import { createVM } from '@ethereumjs/vm';
import { createAddressFromString, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { Interface, AbiCoder } from 'ethers';
import { compileCreditContracts } from './compile-credit-contracts.mjs';
const compiled = compileCreditContracts();
const c = compiled.contracts['DawgToken.sol'].DawgToken;
const abi = new Interface(c.abi);
const vm = await createVM();
const addr = n => createAddressFromString('0x'+n.toString(16).padStart(40,'0'));
const owner=addr(100), treasury=addr(101), alice=addr(102), bob=addr(103);
const init = '0x'+c.evm.bytecode.object+AbiCoder.defaultAbiCoder().encode(['string','string','address','uint256'],['Offline','OFF',owner.toString(),1000n]).slice(2);
const deployed = await vm.evm.runCall({caller:owner,data:hexToBytes(init),gasLimit:20000000n});
assert.equal(deployed.execResult.exceptionError,undefined);
const token = deployed.createdAddress;
let checks=0;
async function call(who, name, args=[], error) {
 const r = await vm.evm.runCall({caller:who,to:token,data:hexToBytes(abi.encodeFunctionData(name,args)),gasLimit:10000000n});
 if (error) {
   assert.ok(r.execResult.exceptionError, name+' must revert');
   if (error !== true) assert.equal(abi.parseError(bytesToHex(r.execResult.returnValue)).name,error);
   checks++; return;
 }
 assert.equal(r.execResult.exceptionError,undefined,name+' unexpectedly reverted: '+bytesToHex(r.execResult.returnValue));
 return abi.decodeFunctionResult(name,bytesToHex(r.execResult.returnValue));
}
const mint=(who,n)=>call(owner,'mint',[who.toString(),n,true,'0x']);
const transfer=(from,to,n)=>call(from,'transfer',[from.toString(),to.toString(),n,true,'0x']);
async function balances(who,b,s) {
 assert.equal((await call(owner,'balanceOf',[who.toString()]))[0],b);
 assert.equal((await call(owner,'soulbound',[who.toString()]))[0],s); checks++;
}
await call(owner,'mint',[alice.toString(),10n,true,'0x'],'TreasuryNotSet');
await call(owner,'setTreasury',[addr(0).toString()],'InvalidTreasury');
await call(owner,'setTreasury',[token.toString()],'InvalidTreasury');
await call(alice,'setTreasury',[treasury.toString()],true);
await call(owner,'setTreasury',[treasury.toString()]);
await mint(alice,10n); await balances(alice,10n,10n);
await call(owner,'setTreasury',[alice.toString()],'TreasuryAlreadySet');
await call(alice,'transfer',[alice.toString(),bob.toString(),1n,true,'0x'],'DawgSoulboundLocked');
// LSP7 may reject self-transfers itself; either outcome must preserve accounting.
const self=await vm.evm.runCall({caller:alice,to:token,data:hexToBytes(abi.encodeFunctionData('transfer',[alice.toString(),alice.toString(),1n,true,'0x'])),gasLimit:10000000n});
await balances(alice,10n,10n);
await mint(treasury,5n); await balances(treasury,5n,0n);
await vm.evm.runCall({caller:treasury,to:token,data:hexToBytes(abi.encodeFunctionData('transfer',[treasury.toString(),treasury.toString(),1n,true,'0x'])),gasLimit:10000000n});
await balances(treasury,5n,0n);
await transfer(treasury,bob,3n); await transfer(bob,alice,2n); await balances(alice,12n,10n);
await transfer(alice,bob,2n); await balances(alice,10n,10n);
await call(alice,'authorizeOperator',[bob.toString(),3n,'0x']);
await call(bob,'transfer',[alice.toString(),treasury.toString(),2n,true,'0x']);
await balances(alice,8n,8n);
assert.equal((await call(owner,'authorizedAmountFor',[bob.toString(),alice.toString()]))[0],1n); checks++;
await call(alice,'burn',[alice.toString(),3n,'0x']); await balances(alice,5n,5n);
await transfer(treasury,bob,4n); await balances(treasury,0n,0n);
await call(owner,'mint',[alice.toString(),1001n,true,'0x'],true);
await balances(alice,5n,5n);
console.log('PASS:',checks,'offline EVM assertions; no RPC/keys/deployment');
