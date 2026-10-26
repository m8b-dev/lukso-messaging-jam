// Offline only: no credentials, RPC, deployment, or frontend dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
const here = path.dirname(fileURLToPath(import.meta.url));
const modules = path.resolve(here, '../node_modules');
export function compileCreditContracts() {
  const sources = Object.fromEntries(['DawgToken.sol', 'CreditDistributor.sol'].map(name =>
    [name, {content: fs.readFileSync(path.resolve(here, '../../contracts/dao', name), 'utf8')} ]));
  const input = {language:'Solidity', sources, settings:{evmVersion:'shanghai', optimizer:{enabled:true,runs:200}, outputSelection:{'*':{'*':['abi','evm.bytecode.object','evm.deployedBytecode.object']}}}};
  const out = JSON.parse(solc.compile(JSON.stringify(input), {import(name) {
    const target = path.resolve(modules, name);
    if (!target.startsWith(modules + path.sep)) return {error:'Import outside dependency directory'};
    try { return {contents:fs.readFileSync(target,'utf8')}; } catch { return {error:'Missing declared dependency: '+name}; }
  }}));
  for (const e of out.errors || []) if (e.severity === 'error') throw new Error(e.formattedMessage);
  return {contracts:out.contracts, warnings:(out.errors || []).filter(e=>e.severity !== 'error'), compiler:solc.version()};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = compileCreditContracts();
  console.log('Compiler:',out.compiler, '| EVM: shanghai | optimizer: 200');
  for (const name of ['DawgToken','CreditDistributor']) {
    const c = out.contracts[name+'.sol'][name];
    console.log(name+': compiled; runtime '+c.evm.deployedBytecode.object.length/2+' bytes');
  }
  console.log('Warnings:',out.warnings.length);
}
