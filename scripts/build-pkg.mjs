#!/usr/bin/env node
// Builds the macOS installer package (PRD "Packaging": signed .pkg).
//
//   node scripts/build-pkg.mjs --out <dir> [--sign "Developer ID Installer: …"] [--no-bundle-node]
//
// Payload: /usr/local/lib/conductor (bin, dist, ui/dist, examples, production
// node_modules, optionally a node runtime). The postinstall script adds
// /usr/local/bin/conductor and /usr/local/bin/conductord. The package never
// loads a launchd job — `conductor install` does, as the logged-in user.
//
// The package is specific to this machine's CPU architecture (sqlite-vec ships
// one native library per architecture). Requires a finished `npm run build`.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  COMMANDS, PKG_IDENTIFIER, PKG_LIB_DIR, REPO_ROOT, fill, installerArch, isSelfContained, missingFiles, packTarball, parseArgs, pkgFileName, readPackage,
  REQUIRED_PACKED_FILES, run,
} from './package-lib.mjs';

const PACKAGING = join(REPO_ROOT, 'packaging', 'pkg');

function main() {
  if (process.platform !== 'darwin') throw new Error('the .pkg can only be built on macOS (pkgbuild, productbuild)');
  const opts = parseArgs(process.argv.slice(2), { out: 'string', sign: 'string', 'no-bundle-node': 'boolean' });
  if (!opts.out) throw new Error('usage: build-pkg.mjs --out <dir> [--sign "<Developer ID Installer identity>"] [--no-bundle-node]');
  const out = resolve(String(opts.out));
  const identity = opts.sign ?? process.env.CONDUCTOR_PKG_SIGN_IDENTITY;
  const pkg = readPackage();
  const arch = process.arch;

  const work = join(out, 'pkg-work');
  rmSync(work, { recursive: true, force: true });
  const app = join(work, 'root');
  mkdirSync(app, { recursive: true });

  // 1. The same tarball the Homebrew formula installs: package.json "files" decides what ships.
  const tarball = packTarball(work);
  run('/usr/bin/tar', ['-xzf', tarball.file, '-C', app, '--strip-components', '1']);

  // 2. Production dependencies, exactly as locked.
  copyFileSync(join(REPO_ROOT, 'package-lock.json'), join(app, 'package-lock.json'));
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: app, stdio: ['ignore', 'inherit', 'inherit'] });
  const missing = missingFiles(app, [...REQUIRED_PACKED_FILES, 'node_modules/better-sqlite3/package.json', `node_modules/sqlite-vec-darwin-${arch}/vec0.dylib`, 'node_modules/playwright/package.json']);
  if (missing.length) throw new Error(`staged tree is incomplete: ${missing.join(', ')}`);

  // 3. Node runtime: bundled when this node is a relocatable build, otherwise the target Mac supplies one.
  mkdirSync(join(app, 'libexec'));
  let bundledNode = false;
  if (!opts['no-bundle-node']) {
    bundledNode = isSelfContained(run('/usr/bin/otool', ['-L', process.execPath]));
    if (bundledNode) {
      copyFileSync(process.execPath, join(app, 'libexec', 'node'));
      chmodSync(join(app, 'libexec', 'node'), 0o755);
    } else {
      console.warn(`note: ${process.execPath} links against non-system libraries and cannot be bundled;`);
      console.warn(`      the package will use the Node.js (${pkg.engines.node}) found on the target Mac.`);
      console.warn('      Run this script with a nodejs.org build of node to produce a self-contained package.');
    }
  }

  // 4. Command wrappers (copied to /usr/local/bin by postinstall) and a build record.
  const template = readFileSync(join(PACKAGING, 'wrapper.sh.in'), 'utf8');
  for (const command of COMMANDS) {
    const file = join(app, 'libexec', command);
    writeFileSync(file, fill(template, { VERSION: pkg.version, COMMAND: command, LIB_DIR: PKG_LIB_DIR, NODE_RANGE: pkg.engines.node }));
    chmodSync(file, 0o755);
  }
  writeFileSync(join(app, 'libexec', 'build.json'), `${JSON.stringify({ version: pkg.version, arch, bundledNode, builtWithNode: process.versions.node }, null, 2)}\n`);

  // 5. Smoke-test the staged tree with its own dependencies before wrapping it.
  const node = bundledNode ? join(app, 'libexec', 'node') : process.execPath;
  for (const command of COMMANDS) {
    const printed = run(node, [join(app, 'bin', `${command}.mjs`), '--version'], { env: { PATH: process.env.PATH ?? '', HOME: work, CONDUCTOR_HOME: join(work, 'home') } }).trim();
    if (printed !== pkg.version) throw new Error(`staged ${command} --version printed "${printed}", expected ${pkg.version}`);
  }
  rmSync(join(work, 'home'), { recursive: true, force: true });

  // 6. Component package, then the distribution (title, architecture gate, conclusion page, signature).
  const component = join(work, 'conductor-component.pkg');
  run('/usr/bin/pkgbuild', ['--root', app, '--identifier', PKG_IDENTIFIER, '--version', pkg.version, '--install-location', PKG_LIB_DIR, '--scripts', join(PACKAGING, 'scripts'), '--ownership', 'recommended', component]);
  const distribution = join(work, 'distribution.xml');
  writeFileSync(distribution, fill(readFileSync(join(PACKAGING, 'distribution.xml.in'), 'utf8'), { VERSION: pkg.version, ARCH: installerArch(arch), IDENTIFIER: PKG_IDENTIFIER, COMPONENT: 'conductor-component.pkg' }));
  const resources = join(work, 'resources');
  cpSync(join(PACKAGING, 'resources'), resources, { recursive: true });
  const product = join(out, pkgFileName(pkg.version, arch));
  rmSync(product, { force: true });
  run('/usr/bin/productbuild', ['--distribution', distribution, '--package-path', work, '--resources', resources, ...(identity ? ['--sign', String(identity)] : []), product]);
  if (!existsSync(product)) throw new Error('productbuild produced no package');
  rmSync(work, { recursive: true, force: true });

  console.log(`${product}`);
  console.log(`  version ${pkg.version}, ${arch}, node ${bundledNode ? 'bundled' : `not bundled (needs ${pkg.engines.node} on the target)`}`);
  if (identity) console.log(`  signed with: ${identity}   (verify: pkgutil --check-signature ${product})`);
  else console.warn('  UNSIGNED. Pass --sign "<Developer ID Installer identity>" (or CONDUCTOR_PKG_SIGN_IDENTITY) for a release build.');
}

try {
  main();
} catch (err) {
  console.error(`build-pkg: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
