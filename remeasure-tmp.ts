import { readdirSync } from 'fs';
import { currentVerdict, preF1aVerdict } from './tests/support/pre-f1a-audit-name-reader';

const dir = 'architecture/fixtures/audit-inventory-assembly';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.ts'))
  .sort();
let exitZero = 0;
for (const f of files) {
  const path = `${dir}/${f}`;
  const pre = preF1aVerdict(path);
  const now = currentVerdict(path);
  if (pre.exitCode === 0) exitZero += 1;
  console.log(
    `${f.padEnd(42)} pre: exit=${pre.exitCode} v=${pre.violations} rules=[${pre.rules.join(',')}] names=[${pre.names.join(' ')}]`,
  );
  console.log(
    `${''.padEnd(42)} now: exit=${now.exitCode} v=${now.violations} rules=[${now.rules.join(',')}] names=[${now.names.join(' ')}]`,
  );
}
console.log(`\nfiles=${files.length} pre-F1a exit-0 count=${exitZero}`);
