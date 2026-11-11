#!/usr/bin/env node
// Builds the Homebrew release artifacts (PRD "Packaging": Homebrew formula).
//
//   node scripts/build-formula.mjs --out <dir> --url-base <https://…/releases/download/vX.Y.Z> [--homepage <url>]
//
// Writes <dir>/conductor-<version>.tgz (npm pack of the built tree) and
// <dir>/conductor.rb, a formula whose `url` is <url-base>/conductor-<version>.tgz
// and whose sha256 is that of the tarball. Upload the tarball to that URL and
// put conductor.rb in the tap's Formula/ directory. Nothing is uploaded here.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { REPO_ROOT, fill, packTarball, parseArgs, readPackage } from './package-lib.mjs';

/** Used when --url-base / --homepage are not given; the result is for inspection only, not for a tap. */
const PLACEHOLDER_REPO = 'https://github.com/OWNER/conductor';

function main() {
  const opts = parseArgs(process.argv.slice(2), { out: 'string', 'url-base': 'string', homepage: 'string' });
  if (!opts.out) throw new Error('usage: build-formula.mjs --out <dir> --url-base <release download URL> [--homepage <url>]');
  const out = resolve(String(opts.out));
  const pkg = readPackage();
  const tarball = packTarball(out);
  const base = String(opts['url-base'] ?? `${PLACEHOLDER_REPO}/releases/download/v${pkg.version}`).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) throw new Error('--url-base must be an https URL');
  const formula = fill(readFileSync(join(REPO_ROOT, 'packaging', 'homebrew', 'conductor.rb.in'), 'utf8'), {
    DESC: pkg.description,
    HOMEPAGE: String(opts.homepage ?? PLACEHOLDER_REPO),
    URL: `${base}/${tarball.filename}`,
    SHA256: tarball.sha256,
  });
  const file = join(out, 'conductor.rb');
  writeFileSync(file, formula);
  console.log(tarball.file);
  console.log(file);
  console.log(`  version ${tarball.version}, ${tarball.entryCount} files, sha256 ${tarball.sha256}`);
  if (!opts['url-base']) console.warn(`  PLACEHOLDER URL (${PLACEHOLDER_REPO}). Pass --url-base and --homepage for a formula a tap can serve.`);
}

try {
  main();
} catch (err) {
  console.error(`build-formula: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
