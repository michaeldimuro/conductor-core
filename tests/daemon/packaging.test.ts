import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  COMMANDS, PKG_LIB_DIR, REPO_ROOT, REQUIRED_PACKED_FILES, fill, installerArch, isSelfContained, missingFiles, parseArgs, pkgFileName, readPackage,
} from '../../scripts/package-lib.mjs';

const darwin = process.platform === 'darwin';
const packaging = (...p: string[]) => join(REPO_ROOT, 'packaging', ...p);
const read = (...p: string[]) => readFileSync(packaging(...p), 'utf8');

describe('packaging (PRD "Packaging": signed .pkg / Homebrew formula)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-packaging-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('package.json', () => {
    const pkg = readPackage();

    it('ships everything an installed copy needs', () => {
      // The daemon serves ui/dist from the package root; without it the web UI is a 404.
      for (const entry of ['bin', 'dist', 'ui/dist', 'examples']) expect(pkg.files).toContain(entry);
      const covered = (file: string) => file === 'package.json' || pkg.files.some((f) => file === f || file.startsWith(`${f}/`));
      expect(REQUIRED_PACKED_FILES.filter((f) => !covered(f))).toEqual([]);
    });

    it('puts conductor and conductord on PATH', () => {
      expect(Object.keys(pkg.bin).sort()).toEqual([...COMMANDS].sort());
      for (const command of COMMANDS) expect(existsSync(join(REPO_ROOT, pkg.bin[command]!))).toBe(true);
    });

    it('has npm scripts for both artifacts', () => {
      expect(pkg.scripts['package:pkg']).toBe('node scripts/build-pkg.mjs');
      expect(pkg.scripts['package:formula']).toBe('node scripts/build-formula.mjs');
    });
  });

  describe('helpers', () => {
    it('fill replaces placeholders and rejects unknown ones', () => {
      expect(fill('a @X@ b @Y_2@ @X@', { X: 'one', Y_2: 2 })).toBe('a one b 2 one');
      expect(() => fill('@MISSING@', {})).toThrow(/@MISSING@/);
    });

    it('isSelfContained accepts system-only linkage and rejects Homebrew linkage', () => {
      const system = '/x/node:\n\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0)\n';
      expect(isSelfContained(system)).toBe(true);
      expect(isSelfContained(`${system}\t/opt/homebrew/opt/libuv/lib/libuv.1.dylib (compatibility version 1.0.0)\n`)).toBe(false);
      expect(isSelfContained(`${system}\t@rpath/libnode.141.dylib (compatibility version 0.0.0)\n`)).toBe(false);
      expect(isSelfContained('/x/node:\n')).toBe(false);
    });

    it('names the package per architecture, in Installer terms', () => {
      expect(pkgFileName('1.2.3', 'arm64')).toBe('conductor-1.2.3-arm64.pkg');
      expect(installerArch('arm64')).toBe('arm64');
      expect(installerArch('x64')).toBe('x86_64');
      expect(() => installerArch('ia32')).toThrow(/unsupported/);
    });

    it('parseArgs reads values and flags and rejects anything else', () => {
      const spec = { out: 'string', sign: 'string', 'no-bundle-node': 'boolean' } as const;
      expect(parseArgs(['--out', '/tmp/x', '--sign=Developer ID Installer: Example (TEAMID)', '--no-bundle-node'], spec)).toEqual({ out: '/tmp/x', sign: 'Developer ID Installer: Example (TEAMID)', 'no-bundle-node': true });
      expect(() => parseArgs(['--publish'], spec)).toThrow(/unknown argument/);
      expect(() => parseArgs(['--out'], spec)).toThrow(/needs a value/);
    });

    it('missingFiles reports what a tree lacks', () => {
      mkdirSync(join(dir, 'dist', 'cli'), { recursive: true });
      writeFileSync(join(dir, 'dist', 'cli', 'main.js'), '');
      expect(missingFiles(dir, ['dist/cli/main.js', 'ui/dist/index.html'])).toEqual(['ui/dist/index.html']);
    });
  });

  describe('.pkg', () => {
    /** A stand-in for /usr/local/lib/conductor whose "CLI" prints which runtime ran it and its arguments. */
    const fakeLib = (): string => {
      const lib = join(dir, 'usr', 'local', 'lib', 'conductor');
      mkdirSync(join(lib, 'bin'), { recursive: true });
      mkdirSync(join(lib, 'libexec'), { recursive: true });
      for (const command of COMMANDS) {
        writeFileSync(join(lib, 'bin', `${command}.mjs`), '');
        const wrapper = fill(read('pkg', 'wrapper.sh.in'), { VERSION: '9.9.9', COMMAND: command, LIB_DIR: lib, NODE_RANGE: '>=22' });
        writeFileSync(join(lib, 'libexec', command), wrapper);
        chmodSync(join(lib, 'libexec', command), 0o755);
      }
      return lib;
    };
    const fakeNode = (file: string, tag: string) => {
      writeFileSync(file, `#!/bin/sh\necho "${tag} $*"\n`);
      chmodSync(file, 0o755);
    };

    it('wrapper is valid sh, prefers the bundled node and passes arguments through', () => {
      const lib = fakeLib();
      const wrapper = join(lib, 'libexec', 'conductor');
      execFileSync('/bin/sh', ['-n', wrapper]);
      mkdirSync(join(dir, 'path'));
      fakeNode(join(dir, 'path', 'node'), 'path-node');
      const env = { PATH: `${join(dir, 'path')}:/usr/bin:/bin` };
      expect(execFileSync(wrapper, ['org', 'list', 'two words'], { env, encoding: 'utf8' }).trim()).toBe(`path-node ${lib}/bin/conductor.mjs org list two words`);
      fakeNode(join(lib, 'libexec', 'node'), 'bundled-node');
      expect(execFileSync(wrapper, ['--version'], { env, encoding: 'utf8' }).trim()).toBe(`bundled-node ${lib}/bin/conductor.mjs --version`);
    });

    it('wrapper fails clearly when there is no node', () => {
      const lib = fakeLib();
      const noFallback = readFileSync(join(lib, 'libexec', 'conductord'), 'utf8').replace('/opt/homebrew/bin/node /usr/local/bin/node', join(dir, 'absent', 'node'));
      const file = join(dir, 'conductord');
      writeFileSync(file, noFallback, { mode: 0o755 });
      const res = spawnSync('/bin/sh', [file, '--serve'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
      expect(res.status).toBe(127);
      expect(res.stderr).toContain('Node.js >=22 is required');
    });

    it('postinstall installs real command files next to the lib dir, replacing an older symlink', () => {
      const lib = fakeLib();
      const bin = join(dir, 'usr', 'local', 'bin');
      mkdirSync(bin, { recursive: true });
      const elsewhere = join(dir, 'old-wrapper');
      writeFileSync(elsewhere, 'old');
      symlinkSync(elsewhere, join(bin, 'conductord'));
      execFileSync('/bin/sh', [packaging('pkg', 'scripts', 'postinstall'), 'conductor.pkg', lib, '/', '/']);
      for (const command of COMMANDS) {
        const st = lstatSync(join(bin, command));
        expect(st.isSymbolicLink()).toBe(false);
        expect(st.mode & 0o777).toBe(0o755);
        expect(readFileSync(join(bin, command), 'utf8')).toBe(readFileSync(join(lib, 'libexec', command), 'utf8'));
      }
      // The symlink was replaced, not written through.
      expect(readFileSync(elsewhere, 'utf8')).toBe('old');
    });

    it('preinstall clears the previous application tree and nothing else', () => {
      const lib = fakeLib();
      writeFileSync(join(lib, 'stale.js'), '');
      const keep = join(dir, 'keep');
      mkdirSync(keep);
      const script = packaging('pkg', 'scripts', 'preinstall');
      execFileSync('/bin/sh', [script, 'conductor.pkg', keep, '/', '/'], { stdio: 'ignore' });
      expect(existsSync(keep)).toBe(true);
      execFileSync('/bin/sh', [script, 'conductor.pkg', lib, '/', '/']);
      expect(existsSync(lib)).toBe(false);
      expect(existsSync(join(dir, 'usr', 'local', 'lib'))).toBe(true);
    });

    it('installer scripts are executable and never touch launchd or user data', () => {
      const scripts = readdirSync(packaging('pkg', 'scripts'));
      expect(scripts.sort()).toEqual(['postinstall', 'preinstall']);
      for (const name of scripts) {
        expect(lstatSync(packaging('pkg', 'scripts', name)).mode & 0o111).not.toBe(0);
        const code = read('pkg', 'scripts', name).split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
        expect(code).not.toMatch(/launchctl|LaunchAgents|LaunchDaemons|\.conductor|\$HOME|~\//);
      }
    });

    it.runIf(darwin)('distribution template renders to well-formed XML gated on the build architecture', () => {
      const xml = fill(read('pkg', 'distribution.xml.in'), { VERSION: '9.9.9', ARCH: installerArch('x64'), IDENTIFIER: 'ai.conductor.pkg', COMPONENT: 'c.pkg' });
      const file = join(dir, 'distribution.xml');
      writeFileSync(file, xml);
      execFileSync('/usr/bin/xmllint', ['--noout', file]);
      expect(xml).toContain('hostArchitectures="x86_64"');
      expect(xml).toContain('<conclusion file="conclusion.html"');
      expect(existsSync(packaging('pkg', 'resources', 'conclusion.html'))).toBe(true);
    });

    it('installs under the path the PRD plist points at', () => {
      expect(PKG_LIB_DIR).toBe('/usr/local/lib/conductor');
    });
  });

  describe('Homebrew formula', () => {
    const render = () => fill(read('homebrew', 'conductor.rb.in'), {
      DESC: readPackage().description,
      HOMEPAGE: 'https://example.invalid/conductor',
      URL: 'https://example.invalid/releases/download/v9.9.9/conductor-9.9.9.tgz',
      SHA256: 'a'.repeat(64),
    });

    it.runIf(darwin)('renders to valid Ruby', () => {
      const file = join(dir, 'conductor.rb');
      writeFileSync(file, render());
      expect(execFileSync('/usr/bin/ruby', ['-c', file], { encoding: 'utf8' })).toContain('Syntax OK');
    });

    it('installs with npm, links both commands and declares no brew service', () => {
      const formula = render();
      expect(formula).toContain('class Conductor < Formula');
      expect(formula).toContain('depends_on "node"');
      expect(formula).toContain('system "npm", "install", *std_npm_args');
      expect(formula).toContain('bin.install_symlink libexec.glob("bin/*")');
      expect(formula).toMatch(/^ {2}sha256 "a{64}"$/m);
      // The daemon's launchd job is `conductor install`'s; a brew service would be a second daemon.
      expect(formula).not.toMatch(/^\s*service do/m);
      expect(formula).not.toContain('launchctl');
      expect(formula).toContain('conductor install');
    });
  });

  it('templates carry no machine- or person-specific values', () => {
    const files = [['pkg', 'wrapper.sh.in'], ['pkg', 'distribution.xml.in'], ['pkg', 'resources', 'conclusion.html'], ['pkg', 'scripts', 'preinstall'], ['pkg', 'scripts', 'postinstall'], ['homebrew', 'conductor.rb.in']];
    for (const f of files) expect(read(...f)).not.toMatch(/\/Users\/|\/Volumes\/|@[a-z0-9-]+\.(com|org|io)\b/i);
  });
});
