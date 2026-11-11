import { describe, expect, it, vi } from 'vitest';
import { bounded, isLoopbackHost, RESTART_BUDGET_MS, SHUTDOWN_BUDGET_MS, STARTUP_TARGET_MS, UI_REACHABLE_BUDGET_MS, warnIfExposed } from '../../src/daemon/lifecycle.js';

describe('daemon lifecycle helpers', () => {
  it('recognizes loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '', '192.168.1.10', '10.0.0.1', 'my-mac.local', '128.0.0.1', '1127.0.0.1']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('warns loudly when bound to a non-loopback host, and only then', () => {
    const warn = vi.fn();
    expect(warnIfExposed({ warn }, '127.0.0.1', 7420)).toBe(false);
    expect(warnIfExposed({ warn }, 'localhost', 7420)).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    expect(warnIfExposed({ warn }, '0.0.0.0', 7420)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields).toEqual({ host: '0.0.0.0', port: 7420, exposure: 'all-interfaces' });
    expect(message).toMatch(/SECURITY WARNING/);
    expect(message).toContain('0.0.0.0:7420');
    expect(message).toMatch(/127\.0\.0\.1/);

    expect(warnIfExposed({ warn }, '192.168.1.20', 7420)).toBe(true);
    expect((warn.mock.calls[1] as [Record<string, unknown>])[0]).toMatchObject({ exposure: 'non-loopback' });
  });

  it('budgets fit the PRD: restart < 15 s, UI reachable < 30 s', () => {
    expect(RESTART_BUDGET_MS).toBe(15_000);
    expect(UI_REACHABLE_BUDGET_MS).toBe(30_000);
    // A requested stop followed by a start still fits the restart requirement.
    expect(SHUTDOWN_BUDGET_MS + STARTUP_TARGET_MS).toBeLessThan(RESTART_BUDGET_MS);
  });

  it('bounded() never lets a stuck or failing phase hold up shutdown', async () => {
    const warn = vi.fn();
    const t0 = Date.now();
    expect(await bounded('hang', () => new Promise(() => {}), 60, { warn })).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(await bounded('boom', () => Promise.reject(new Error('x')), 1000, { warn })).toBe('failed');
    expect(await bounded('sync-throw', () => { throw new Error('y'); }, 1000, { warn })).toBe('failed');
    expect(await bounded('fine', async () => 1, 1000, { warn })).toBe('done');
    expect(await bounded('unbounded', async () => 1, Number.POSITIVE_INFINITY, { warn })).toBe('done');
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
