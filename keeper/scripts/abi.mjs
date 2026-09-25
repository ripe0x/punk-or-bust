// Regenerates src/abi/*.json from the Solidity sources with `forge inspect`.
// Run from the keeper directory with foundry on PATH: `npm run abi`.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const outDir = join(here, '..', 'src', 'abi');

const CONTRACTS = ['Vault', 'VaultFactory', 'IFWA'];

for (const name of CONTRACTS) {
  const raw = execFileSync('forge', ['inspect', name, 'abi', '--json'], { cwd: repoRoot, encoding: 'utf8' });
  const abi = JSON.parse(raw);
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(abi, null, 2) + '\n');
  console.log(`${name}: ${abi.length} entries`);
}
