// Shared helpers for the packaging scripts (build-pkg.mjs, build-formula.mjs).
// Pure where possible so tests/daemon/packaging.test.ts can cover them without building anything.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '');

/** Where the .pkg puts the application, and where its two commands go. */
export const PKG_LIB_DIR = '/usr/local/lib/conductor';
export const PKG_BIN_DIR = '/usr/local/bin';
export const PKG_IDENTIFIER = 'ai.conductor.pkg';
export const COMMANDS = ['conductor', 'conductord'];

/** Files a built tree must contain before it can be packaged. */
export const REQUIRED_BUILD_FILES = ['dist/cli/main.js', 'dist/daemon/main.js', 'dist/adapters/sdk.js', 'ui/dist/index.html'];

/** Files the packed tarball must contain for an installed copy to work. */
export const REQUIRED_PACKED_FILES = ['package.json', 'bin/conductor.mjs', 'bin/conductord.mjs', ...REQUIRED_BUILD_FILES];

export function readPackage(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

/** Paths from `required` that are absent under `root`. */
export function missingFiles(root, required = REQUIRED_BUILD_FILES) {
  return required.filter((f) => !existsSync(join(root, f)));
}

/** Replace every `@KEY@` in a template; an unknown or leftover placeholder is an error, not silent output. */
export function fill(template, values) {
  const out = template.replace(/@([A-Z0-9_]+)@/g, (m, key) => {
    if (!(key in values)) throw new Error(`template placeholder ${m} has no value`);
    return String(values[key]);
  });
  return out;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * True when a Mach-O binary links only against system libraries, i.e. it can be
 * copied to another Mac. `otoolOutput` is the text of `otool -L <binary>`.
 * Homebrew's node links against /opt/homebrew dylibs and is not relocatable;
 * the nodejs.org builds are.
 */
export function isSelfContained(otoolOutput) {
  const libs = otoolOutput
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' (')[0])
    .filter(Boolean);
  return libs.length > 0 && libs.every((l) => l.startsWith('/usr/lib/') || l.startsWith('/System/Library/'));
}

/** Node's `process.arch` → the name Installer uses in `hostArchitectures`. */
export function installerArch(arch) {
  if (arch === 'arm64') return 'arm64';
  if (arch === 'x64') return 'x86_64';
  throw new Error(`unsupported architecture for a macOS package: ${arch}`);
}

/** `conductor-0.1.0-arm64.pkg` */
export function pkgFileName(version, arch) {
  return `conductor-${version}-${arch}.pkg`;
}

/** `{ sign, out, ... }` from `--flag value`, `--flag=value` and bare `--flag`; unknown flags are an error. */
export function parseArgs(argv, spec) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].replace(/^--/, '').split(/=(.*)/s, 2);
    if (!argv[i].startsWith('--') || !(name in spec)) throw new Error(`unknown argument: ${argv[i]}`);
    if (spec[name] === 'boolean') opts[name] = true;
    else {
      const value = inline ?? argv[++i];
      if (value === undefined || value === '') throw new Error(`--${name} needs a value`);
      opts[name] = value;
    }
  }
  return opts;
}

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}

/**
 * `npm pack` the built tree into `outDir`. The `files` list in package.json is
 * the single definition of what ships; both the .pkg and the formula start here.
 */
export function packTarball(outDir, root = REPO_ROOT) {
  const missing = missingFiles(root);
  if (missing.length) throw new Error(`not built: missing ${missing.join(', ')} — run \`npm run build\` first`);
  mkdirSync(outDir, { recursive: true });
  const [info] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', resolve(outDir)], { cwd: root }));
  const packed = new Set(info.files.map((f) => f.path));
  const absent = REQUIRED_PACKED_FILES.filter((f) => !packed.has(f));
  if (absent.length) throw new Error(`the tarball is missing ${absent.join(', ')} — check "files" in package.json`);
  const file = join(resolve(outDir), info.filename);
  return { file, filename: info.filename, version: info.version, sha256: sha256File(file), entryCount: info.files.length };
}
