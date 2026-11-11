import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  EXIT_TIMEOUT_S, installLaunchAgent, LABEL, launchAgentPath, renderHeadlessDaemonPlist, renderPlist, renderWrapper,
} from '../../src/daemon/launchd.js';
import { RESTART_BUDGET_MS, SHUTDOWN_BUDGET_MS } from '../../src/daemon/lifecycle.js';

const darwin = process.platform === 'darwin';

describe('launchd packaging (FR-1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-launchd-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** plutil is the authority on whether launchd will accept a file; it also parses it back for us. */
  const lintAndParse = (xml: string): Record<string, unknown> => {
    const file = join(dir, `p-${Math.random().toString(36).slice(2)}.plist`);
    writeFileSync(file, xml);
    expect(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' })).toContain('OK');
    return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' })) as Record<string, unknown>;
  };

  it('renders the PRD plist keys', () => {
    const plist = renderPlist({ program: '/usr/local/bin/conductord', logDir: '/tmp/logs', env: { CONDUCTOR_HOME: '/tmp/h' } });
    expect(plist).toContain(`<key>Label</key><string>${LABEL}</string>`);
    expect(plist).toContain('<array><string>/usr/local/bin/conductord</string><string>--serve</string></array>');
    expect(plist).toContain('<key>RunAtLoad</key><true/>');
    expect(plist).toContain('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>');
    expect(plist).toContain('<key>ThrottleInterval</key><integer>10</integer>');
    expect(plist).toContain('/tmp/logs/conductord.out.log');
    expect(plist).toContain('/tmp/logs/conductord.err.log');
    expect(LABEL).toBe('ai.conductor.daemon');
    expect(launchAgentPath()).toBe(join(homedir(), 'Library', 'LaunchAgents', 'ai.conductor.daemon.plist'));
  });

  it.skipIf(!darwin)('the LaunchAgent plist passes plutil -lint and parses back to the PRD values', () => {
    const p = lintAndParse(renderPlist({
      program: '/usr/local/bin/conductord', logDir: join(homedir(), 'Library', 'Logs', 'Conductor'),
      env: { PATH: '/usr/bin:/bin', HOME: homedir(), CONDUCTOR_HOME: '/Users/me/.conductor' },
    }));
    expect(p.Label).toBe('ai.conductor.daemon');
    expect(p.ProgramArguments).toEqual(['/usr/local/bin/conductord', '--serve']);
    expect(p.RunAtLoad).toBe(true);
    // Restart on crash (non-zero exit), stay down after a clean requested stop.
    expect(p.KeepAlive).toEqual({ SuccessfulExit: false });
    expect(p.ThrottleInterval).toBe(10);
    expect(p.StandardOutPath).toBe(join(homedir(), 'Library', 'Logs', 'Conductor', 'conductord.out.log'));
    expect(p.StandardErrorPath).toBe(join(homedir(), 'Library', 'Logs', 'Conductor', 'conductord.err.log'));
    expect(p.WorkingDirectory).toBe('/Users/me/.conductor');
    // A LaunchAgent in the GUI session: that is what gives agents the Keychain and a browser.
    expect(p.ProcessType).toBe('Interactive');
    expect(p.LimitLoadToSessionType).toBe('Aqua');
    expect(p.UserName).toBeUndefined();
    expect(p.EnvironmentVariables).toEqual({ PATH: '/usr/bin:/bin', HOME: homedir(), CONDUCTOR_HOME: '/Users/me/.conductor' });
    // Files the daemon creates are private (umask 077), and launchd waits out our graceful shutdown before SIGKILL.
    expect(p.Umask).toBe(0o077);
    expect(p.ExitTimeOut).toBe(EXIT_TIMEOUT_S);
  });

  it('keeps stop + throttle + start inside the 15 s restart requirement', () => {
    expect(EXIT_TIMEOUT_S * 1000).toBeGreaterThan(SHUTDOWN_BUDGET_MS);
    expect(EXIT_TIMEOUT_S * 1000).toBeLessThan(RESTART_BUDGET_MS);
    expect(SHUTDOWN_BUDGET_MS).toBeLessThan(RESTART_BUDGET_MS);
  });

  it('escapes XML in paths and env', () => {
    const xml = renderPlist({ program: '/a&b/<c>', logDir: '/l', env: { X: 'a<b&c' } });
    expect(xml).toContain('/a&amp;b/&lt;c&gt;');
    expect(xml).toContain('a&lt;b&amp;c');
    if (darwin) {
      const p = lintAndParse(xml);
      expect(p.ProgramArguments).toEqual(['/a&b/<c>', '--serve']);
      expect(p.EnvironmentVariables).toEqual({ X: 'a<b&c' });
    }
  });

  it('writes a valid plist and an executable wrapper without loading it', async () => {
    const res = await installLaunchAgent({
      home: join(dir, 'home'), entry: '/opt/conductor/dist/daemon/main.js', nodePath: '/opt/node/bin/node',
      logDir: join(dir, 'logs'), plistPath: join(dir, 'agent.plist'), load: false, systemLink: false, port: 7421,
    });
    expect(res.loaded).toBe(false);
    expect(res.program).toBe(res.wrapper);
    expect(statSync(res.wrapper).mode & 0o111).not.toBe(0);
    expect(readFileSync(res.wrapper, 'utf8')).toContain(`exec '/opt/node/bin/node' '/opt/conductor/dist/daemon/main.js' "$@"`);
    const plist = readFileSync(res.plistPath, 'utf8');
    expect(plist).toContain('<key>CONDUCTOR_PORT</key><string>7421</string>');
    expect(plist).toContain('/opt/node/bin');
    expect(plist).not.toContain('CONDUCTOR_HOST');
    expect(plist).not.toContain('UserName');
    if (darwin) {
      const p = lintAndParse(plist);
      expect(p.ProgramArguments).toEqual([res.wrapper, '--serve']);
      expect(p.EnvironmentVariables).toMatchObject({ CONDUCTOR_HOME: join(dir, 'home'), CONDUCTOR_LOG_DIR: join(dir, 'logs'), CONDUCTOR_PORT: '7421', HOME: homedir() });
      expect((p.EnvironmentVariables as Record<string, string>).PATH).toMatch(/^\/opt\/node\/bin:/);
      expect(p.StandardOutPath).toBe(join(dir, 'logs', 'conductord.out.log'));
    }
  });

  it('the wrapper survives hostile install paths', () => {
    const script = join(dir, 'wrapper.sh');
    const marker = join(dir, 'pwned');
    // Would run `touch` if the path were interpolated into double quotes.
    writeFileSync(script, renderWrapper('/bin/echo', `it's "$(touch ${marker})" \`touch ${marker}\``), { mode: 0o755 });
    const out = execFileSync('/bin/sh', [script, 'arg'], { encoding: 'utf8' });
    expect(out.trim()).toBe(`it's "$(touch ${marker})" \`touch ${marker}\` arg`);
    expect(existsSync(marker)).toBe(false);
  });

  it('renders the headless LaunchDaemon variant with the file vault and no Keychain', () => {
    const xml = renderHeadlessDaemonPlist({ program: '/usr/local/bin/conductord', home: '/var/conductor', logDir: '/var/log/conductor', userName: 'svc', vaultKeyFile: '/etc/conductor/vault.key' });
    expect(xml).toContain(`${LABEL}.headless`);
    expect(xml).toContain('<key>UserName</key><string>svc</string>');
    expect(xml).toContain('<key>CONDUCTOR_SECRETS</key><string>vault</string>');
    expect(xml).toContain('/etc/conductor/vault.key');
    // The passphrase itself is never in the plist — only the path of a root-only key file.
    expect(xml).not.toContain('CONDUCTOR_VAULT_KEY</key>');
    if (darwin) {
      const p = lintAndParse(xml);
      expect(p.Label).toBe('ai.conductor.daemon.headless');
      expect(p.UserName).toBe('svc');
      expect(p.RunAtLoad).toBe(true);
      expect(p.KeepAlive).toEqual({ SuccessfulExit: false });
      expect(p.ThrottleInterval).toBe(10);
      // No GUI session keys on a LaunchDaemon.
      expect(p.LimitLoadToSessionType).toBeUndefined();
      expect(p.ProcessType).toBeUndefined();
      expect(p.EnvironmentVariables).toMatchObject({ CONDUCTOR_SECRETS: 'vault', CONDUCTOR_HEADLESS: '1', CONDUCTOR_VAULT_KEY_FILE: '/etc/conductor/vault.key', HOME: '/Users/svc', CONDUCTOR_HOME: '/var/conductor' });
      expect(p.StandardErrorPath).toBe('/var/log/conductor/conductord.err.log');
    }
  });

  it('never installs the LaunchDaemon variant: system launchd directories are refused', async () => {
    for (const plistPath of ['/Library/LaunchDaemons/ai.conductor.daemon.headless.plist', '/Library/LaunchAgents/ai.conductor.daemon.plist']) {
      await expect(installLaunchAgent({
        home: join(dir, 'home'), entry: '/opt/conductor/dist/daemon/main.js', logDir: join(dir, 'logs'), plistPath, load: false, systemLink: false,
      })).rejects.toThrow(/per-user LaunchAgent only/);
      expect(existsSync(plistPath)).toBe(false);
    }
  });
});
