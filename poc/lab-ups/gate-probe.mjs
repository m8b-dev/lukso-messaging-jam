// gate-probe.mjs — READ-ONLY. Checks the sybil-gate primitives for the lab UPs:
//   - LSP3 profile present? (getData(LSP3Profile key) non-empty)
//   - LSP26 follower-count / isFollowing wiring sane?
// No tx, no spend. Tells us what the Distributor E2E must establish.

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
const LSP26 = '0xf01103E5a9909Fc0DBe8166dA7085e0285daDDcA';
const LSP3_KEY = '0x5ef83ad9559033e6e941db7d7c495acdce616347d28e90c7ce47cbfcfcad3bc5';

const ERC725Y_ABI = ['function getData(bytes32) view returns (bytes)'];
const LSP26_ABI = [
  'function isFollowing(address follower, address addr) view returns (bool)',
  'function followingCount(address addr) view returns (uint256)',
  'function followerCount(address addr) view returns (uint256)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(EL, CHAIN_ID, { staticNetwork: true });
  const st = JSON.parse(fs.readFileSync(path.join(__dirname, 'state.json'), 'utf8'));
  const ups = { alice: ethers.getAddress(st.alice.upAddress), bob: ethers.getAddress(st.bob.upAddress) };
  const lsp26 = new ethers.Contract(LSP26, LSP26_ABI, provider);

  for (const [name, up] of Object.entries(ups)) {
    console.log(`\n== ${name} ${up} ==`);
    const y = new ethers.Contract(up, ERC725Y_ABI, provider);
    let lsp3 = '0x';
    try { lsp3 = await y.getData(LSP3_KEY); } catch (e) { console.log('  getData err:', e.shortMessage || e.message); }
    console.log('  LSP3 profile len:', (lsp3.length - 2) / 2, 'bytes ->', lsp3 === '0x' || lsp3.length <= 2 ? 'NO PROFILE' : 'HAS PROFILE');
    try {
      const fc = await lsp26.followingCount(up);
      console.log('  LSP26 followingCount:', fc.toString());
    } catch (e) { console.log('  followingCount err:', e.shortMessage || e.message); }
    // does alice follow bob / bob follow alice? just to see isFollowing wiring
    for (const [n2, u2] of Object.entries(ups)) {
      if (u2 === up) continue;
      try { console.log(`  isFollowing(${name}->${n2}):`, await lsp26.isFollowing(up, u2)); }
      catch (e) { console.log('  isFollowing err:', e.shortMessage || e.message); }
    }
  }
  console.log('\n(probe is read-only; no spend)');
}
main().catch((e) => { console.error(e); process.exit(1); });
