// Copies non-TS runtime assets (SQL migrations, templates) into dist/.
import { cpSync, existsSync } from 'node:fs';

for (const [from, to] of [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/assets', 'dist/assets'],
]) {
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}
