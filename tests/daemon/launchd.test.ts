import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { installLaunchAgent, renderHeadlessDaemonPlist, renderPlist, LABEL } from '../../src/daemon/launchd.js';

describe('launchd packaging', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-launchd-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('renders the PRD plist keys', () => {
    const plist = renderPlist({ program: '/usr/local/bin/conductord', logDir: '/tmp/logs', env: { CONDUCTOR_HOME: '/tmp/h' } });
    expect(plist).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(plist).toContain('<array><string>/usr/local/bin/conductord</string><string>--serve</string></array>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    expect(plist).toContain('/tmp/logs/conductord.out.log');
    expect(plist).toContain('/tmp/logs/conductord.err.log');
  });

  it('escapes XML in paths and env', () => {
    const plist = renderPlist({ program: '/a&b/<c>', logDir: '/l', env: { X: 'a<b&c' } });
    expect(plist).toContain('/a&amp;b/&lt;c&gt;');
    expect(plist).toContain('a&lt;b&amp;c');
  });

  it('writes a valid plist and an executable wrapper without loading it', async () => {
    const res = await installLaunchAgent({
      home: join(dir, 'home'), entry: '/opt/conductor/dist/daemon/main.js', nodePath: '/opt/node/bin/node',
      logDir: join(dir, 'logs'), plistPath: join(dir, 'agent.plist'), load: false, systemLink: false, port: 7421,
    });
    expect(res.loaded).toBe(false);
    expect(res.program).toBe(res.wrapper);
    expect(statSync(res.wrapper).mode & 0o111).not.toBe(0);
    expect(readFileSync(res.wrapper, 'utf8')).toContain('exec "/opt/node/bin/node" "/opt/conductor/dist/daemon/main.js" "$@"');
    const plist = readFileSync(res.plistPath, 'utf8');
    expect(plist).toContain('<key>CONDUCTOR_PORT</key><string>7421</string>');
    expect(plist).toContain('/opt/node/bin');
    if (process.platform === 'darwin') {
      // plutil is the authority on whether launchd will accept the file.
      expect(execFileSync('/usr/bin/plutil', ['-lint', res.plistPath], { encoding: 'utf8' })).toContain('OK');
    }
  });

  it('renders the headless LaunchDaemon variant with the file vault and no Keychain', () => {
    const plist = renderHeadlessDaemonPlist({ program: '/usr/local/bin/conductord', home: '/var/conductor', logDir: '/var/log/conductor', userName: 'svc', vaultKeyFile: '/etc/conductor/vault.key' });
    expect(plist).toContain(`${LABEL}.headless`);
    expect(plist).toContain('<key>UserName</key><string>svc</string>');
    expect(plist).toContain('<key>CONDUCTOR_SECRETS</key><string>vault</string>');
    expect(plist).toContain('/etc/conductor/vault.key');
    expect(plist).not.toContain('CONDUCTOR_VAULT_KEY</key>');
  });
});
