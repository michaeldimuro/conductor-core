import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import { SEND_SCRIPT, textFromAttributedBody } from '../../src/gateways/platforms/imessage.js';
import type { Organization } from '../../src/contracts/rows.js';
import { createFakeServices, getGateway, insertGateway, waitFor, type FakeServices } from './fake-services.js';
import { createChatDb, createOsascriptMock, type ChatDbMock, type OsascriptMock } from './mail-servers.js';

const OWNER_HANDLE = '+15551230000';

function attributedBody(text: string): Buffer {
  const utf8 = Buffer.from(text, 'utf8');
  const length = utf8.length < 0x80 ? Buffer.from([utf8.length]) : Buffer.from([0x81, utf8.length & 0xff, utf8.length >> 8]);
  return Buffer.concat([Buffer.from('\u0004\u000bstreamtyped\u0081è\u0003\u0084\u0001@\u0084\u0084\u0084\u0012NSAttributedString\u0000\u0084\u0084\bNSObject\u0000\u0085\u0092\u0084\u0084\u0084\bNSString\u0001\u0094\u0084\u0001', 'latin1'), Buffer.from([0x2b]), length, utf8, Buffer.from([0x86, 0x84])]);
}

describe('gateways / imessage (local bridge)', () => {
  let f: FakeServices;
  let chatDb: ChatDbMock;
  let osascript: OsascriptMock;
  let gw: Gateways | null;
  let acme: Organization;

  const config = (extra: Record<string, unknown> = {}) => ({
    chatDbPath: chatDb.path, osascriptPath: osascript.path, pollMs: 50, allowedChatIds: [OWNER_HANDLE], ...extra,
  });
  const sentTo = (handle: string) => osascript.calls().filter((argv) => argv[2] === handle).map((argv) => argv[3]);
  const sentText = (text: string) => waitFor(() => sentTo(OWNER_HANDLE).includes(text), `iMessage "${text}"`);

  beforeEach(() => {
    f = createFakeServices();
    chatDb = createChatDb();
    osascript = createOsascriptMock();
    gw = null;
    acme = seedOrg(f.k, 'Acme');
    seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
  });
  afterEach(async () => {
    await gw?.stop();
    f.dispose();
  });

  it('receives new rows from allow-listed handles only, replies through osascript, and never replays history', async () => {
    chatDb.addMessage(OWNER_HANDLE, 'old message from before the gateway existed');
    const row = insertGateway(f.k, { kind: 'imessage', orgId: acme.id, config: config() });
    gw = await startGateways(f.services, { pollMs: 0 });
    expect(gw.status()).toEqual([{ id: row.id, kind: 'imessage', status: 'active', lastError: null }]);

    chatDb.addMessage('+19998887777', 'who is this?');
    chatDb.addMessage(OWNER_HANDLE, 'my own outgoing text', { fromMe: true });
    chatDb.addMessage(OWNER_HANDLE, 'Anything blocked?');
    await sentText('echo: Anything blocked?');

    expect(f.chats.map((c) => c.message)).toEqual(['Anything blocked?']);
    expect(osascript.calls().every((argv) => argv[2] === OWNER_HANDLE)).toBe(true);
    expect(getGateway(f.k, row.id).config.state).toEqual({ imessageRowId: 4 });

    // Restart: the persisted ROWID means nothing is handled twice.
    await gw.stop();
    gw = await startGateways(f.services, { pollMs: 0 });
    chatDb.addMessage(OWNER_HANDLE, null, { attributedBody: attributedBody('/status') });
    await waitFor(() => sentTo(OWNER_HANDLE).some((t) => t?.includes('Organization: Acme')), 'status reply');
    expect(f.chats).toHaveLength(1);
  });

  it('passes recipient and text as arguments, never as script source', async () => {
    insertGateway(f.k, { kind: 'imessage', orgId: acme.id, config: config() });
    gw = await startGateways(f.services, { pollMs: 0 });
    const hostile = 'done" \n end tell\n do shell script "rm -rf ~" --';
    f.reply = () => hostile;
    chatDb.addMessage(OWNER_HANDLE, 'say something dangerous');
    await sentText(hostile);
    const argv = osascript.calls().at(-1)!;
    expect(argv).toEqual(['-e', SEND_SCRIPT, OWNER_HANDLE, hostile]);
    expect(SEND_SCRIPT).toContain('on run argv');
    expect(SEND_SCRIPT).not.toContain('rm -rf');
  });

  it('falls back to reply-commands for approvals and decides on /approve', async () => {
    insertGateway(f.k, { kind: 'imessage', orgId: acme.id, config: config() });
    gw = await startGateways(f.services, { pollMs: 0 });
    const approval = f.requestApproval(acme.id, 'Book the venue');
    await gw.idle();
    const notice = sentTo(OWNER_HANDLE).at(-1)!;
    expect(notice).toContain('Approval needed: Book the venue');
    expect(notice).toContain(`Reply "/approve ${approval.id}" to approve`);

    chatDb.addMessage(OWNER_HANDLE, `/approve ${approval.id}`);
    await sentText('Approved: Book the venue');
    expect(f.decisions).toHaveLength(1);
  });

  it('sets status error with a clear Full Disk Access message when chat.db is unreadable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-chatdb-bad-'));
    const notSqlite = join(dir, 'chat.db');
    writeFileSync(notSqlite, 'this is not a sqlite database');
    const missing = insertGateway(f.k, { kind: 'imessage', config: config({ chatDbPath: join(dir, 'nope', 'chat.db') }) });
    const corrupt = insertGateway(f.k, { kind: 'imessage', config: config({ chatDbPath: notSqlite }) });
    const good = insertGateway(f.k, { kind: 'imessage', orgId: acme.id, config: config() });
    gw = await startGateways(f.services, { pollMs: 0 });
    const status = Object.fromEntries(gw.status().map((s) => [s.id, s]));
    expect(status[missing.id]).toMatchObject({ status: 'error' });
    expect(status[missing.id]!.lastError).toContain('cannot read the Messages database');
    expect(status[missing.id]!.lastError).toContain('Full Disk Access');
    expect(status[corrupt.id]).toMatchObject({ status: 'error' });
    expect(status[good.id]).toMatchObject({ status: 'active', lastError: null });
  });

  it('decodes text stored only in attributedBody', () => {
    expect(textFromAttributedBody(attributedBody('hello from a new macOS'))).toBe('hello from a new macOS');
    const long = 'x'.repeat(300);
    expect(textFromAttributedBody(attributedBody(long))).toBe(long);
    expect(textFromAttributedBody(Buffer.from('garbage'))).toBeNull();
    expect(textFromAttributedBody(null)).toBeNull();
  });
});
