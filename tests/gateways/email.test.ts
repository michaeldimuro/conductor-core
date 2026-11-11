import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAgent, seedDept, seedOrg } from '../helpers/kernel.js';
import { startGateways, type Gateways } from '../../src/gateways/index.js';
import { buildMessage, decodeHeaderText, decodeQuotedPrintable, encodeHeaderText, parseMail, stripQuotedReply } from '../../src/gateways/platforms/mime.js';
import { dotStuff, sendMail } from '../../src/gateways/platforms/smtp.js';
import { fetchUnseen } from '../../src/gateways/platforms/imap.js';
import { inboundText } from '../../src/gateways/platforms/email.js';
import type { Organization } from '../../src/contracts/rows.js';
import { createFakeServices, insertGateway, waitFor, type FakeServices } from './fake-services.js';
import { startImapMock, startSmtpMock, type ImapMock, type SmtpMock } from './mail-servers.js';

const FROM = 'conductor@acme.test';
const OWNER_ADDR = 'owner@example.com';
const PASSWORD = 'mail-pass-"quoted"\\slash';

function bodyOf(data: string): string {
  return decodeQuotedPrintable(data.slice(data.indexOf('\r\n\r\n') + 4)).toString('utf8').replace(/\r\n/g, '\n').trimEnd();
}

function inboundMail(opts: { from?: string; subject?: string; body: string; auth?: string | null }): string {
  const headers = [
    ...(opts.auth === null ? [] : [`Authentication-Results: mx.acme.test; ${opts.auth ?? 'dkim=pass header.d=example.com; spf=pass'}`]),
    `From: The Owner <${opts.from ?? OWNER_ADDR}>`,
    `To: ${FROM}`,
    `Subject: ${opts.subject ?? 'Re: [Conductor] hello'}`,
    'Content-Type: text/plain; charset=utf-8',
  ];
  return `${headers.join('\n')}\n\n${opts.body}\n`;
}

describe('gateways / email', () => {
  let smtp: SmtpMock;

  beforeEach(async () => {
    smtp = await startSmtpMock({ username: FROM, password: PASSWORD });
  });
  afterEach(async () => {
    await smtp.close();
  });

  describe('SMTP client', () => {
    const options = () => ({ host: '127.0.0.1', port: smtp.port, secure: false, username: FROM, password: PASSWORD, allowInsecureAuth: true });

    it('speaks a correct dialogue: EHLO, AUTH PLAIN, MAIL, RCPT, DATA with dot-stuffing, QUIT', async () => {
      const text = 'First line\n.starts with a dot\n..two dots\n\nLast line with ünïcödé and = sign';
      const data = buildMessage({ from: FROM, to: OWNER_ADDR, subject: 'Approval needed: Grüße — 承認', text, date: new Date(1_700_000_000_000), messageId: 'id-1@acme.test' });
      await sendMail(options(), { from: FROM, to: OWNER_ADDR, data });

      expect(smtp.commands.map((c) => c.replace(/^EHLO .*/, 'EHLO <host>'))).toEqual([
        'EHLO <host>', 'AUTH PLAIN <credentials>', `MAIL FROM:<${FROM}>`, `RCPT TO:<${OWNER_ADDR}>`, 'DATA', 'QUIT',
      ]);
      expect(smtp.authenticated).toEqual([{ mechanism: 'PLAIN', username: FROM, password: PASSWORD }]);
      expect(smtp.messages).toHaveLength(1);
      const message = smtp.messages[0]!;
      expect(message).toMatchObject({ from: FROM, to: [OWNER_ADDR] });

      // On the wire: CRLF only, leading dots doubled, nothing that could end DATA early.
      expect(message.wire).not.toMatch(/[^\r]\n/);
      expect(message.wire).toContain('\r\n..starts with a dot\r\n');
      expect(message.wire).toContain('\r\n...two dots\r\n');
      expect(message.wire.split('\r\n').every((line) => line.length <= 78)).toBe(true);
      // After the server un-stuffs: the exact message, and the body round-trips.
      expect(message.data).toBe(data);
      expect(bodyOf(message.data)).toBe(text);

      const headers = message.data.slice(0, message.data.indexOf('\r\n\r\n'));
      expect(headers).toContain(`From: Conductor <${FROM}>`);
      expect(headers).toContain(`To: <${OWNER_ADDR}>`);
      expect(headers).toContain('Message-ID: <id-1@acme.test>');
      expect(headers).toContain('Content-Transfer-Encoding: quoted-printable');
      expect(headers).toMatch(/^Date: Tue, 14 Nov 2023 22:13:20 \+0000$/m);
      const subject = /^Subject: ((?:.*)(?:\r\n .*)*)$/m.exec(headers)![1]!;
      expect(subject).toMatch(/^=\?UTF-8\?B\?/);
      expect(decodeHeaderText(subject.replace(/\r\n /g, ' '))).toBe('Approval needed: Grüße — 承認');
    });

    it('falls back to AUTH LOGIN, and fails clearly on bad credentials without leaking them', async () => {
      await smtp.close();
      smtp = await startSmtpMock({ auth: ['LOGIN'], username: FROM, password: PASSWORD });
      await sendMail(options(), { from: FROM, to: OWNER_ADDR, data: 'Subject: x\r\n\r\nbody\r\n' });
      expect(smtp.authenticated).toEqual([{ mechanism: 'LOGIN', username: FROM, password: PASSWORD }]);
      expect(smtp.commands).toContain('AUTH LOGIN');

      const err = await sendMail({ ...options(), password: 'wrong-password' }, { from: FROM, to: OWNER_ADDR, data: 'x' }).catch((e: Error) => e);
      expect((err as Error).message).toBe('SMTP AUTH rejected: 535 5.7.8 Authentication credentials invalid');
      expect(smtp.messages).toHaveLength(1);
    });

    it('refuses to authenticate in plaintext unless explicitly allowed, and rejects injected addresses', async () => {
      await expect(sendMail({ ...options(), allowInsecureAuth: false }, { from: FROM, to: OWNER_ADDR, data: 'x' }))
        .rejects.toThrow(/refusing to send credentials in plaintext/);
      await expect(sendMail(options(), { from: FROM, to: 'a@b.test>\r\nRCPT TO:<evil@x.test', data: 'x' })).rejects.toThrow(/invalid recipient/);
      await expect(sendMail(options(), { from: 'not an address', to: OWNER_ADDR, data: 'x' })).rejects.toThrow(/invalid sender/);
      expect(smtp.messages).toHaveLength(0);
      expect(smtp.commands.filter((c) => c.startsWith('RCPT'))).toEqual([]);
    });

    it('dot-stuffs and normalizes line endings; headers cannot be injected', () => {
      expect(dotStuff('.a\n.\r\nb\r.c')).toBe('..a\r\n..\r\nb\r\n..c\r\n');
      expect(encodeHeaderText('Hello\r\nBcc: evil@x.test')).toBe('Hello Bcc: evil@x.test');
      expect(encodeHeaderText('plain ascii')).toBe('plain ascii');
    });
  });

  describe('inbound parsing', () => {
    it('extracts sender, subject and text from plain, quoted-printable, base64 and multipart mail', () => {
      const qp = parseMail(Buffer.from('From: =?UTF-8?B?SsO8cmdlbg==?= <Owner@Example.com>\r\nSubject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=C3=BC=C3=9Fe aus =\r\nBerlin\r\n'));
      expect(qp).toMatchObject({ from: 'owner@example.com', subject: 'Grüße', text: 'Grüße aus Berlin' });

      const multipart = parseMail(Buffer.from([
        'From: owner@example.com', 'Subject: hi', 'Content-Type: multipart/alternative; boundary="b1"', '',
        '--b1', 'Content-Type: text/html; charset=utf-8', '', '<p>ignored <b>html</b></p>',
        '--b1', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', Buffer.from('/status please').toString('base64'),
        '--b1--', '',
      ].join('\r\n')));
      expect(multipart.text).toBe('/status please');

      expect(parseMail(Buffer.from('From: "Mallory" <not-an-address>\r\n\r\nhi')).from).toBeNull();
      expect(parseMail(Buffer.from('From: x@y.test\r\nContent-Type: text/html\r\n\r\n<div>Hello<br>there</div>')).text).toBe('Hello\nthere');
    });

    it('strips the quoted original and picks commands from the subject or the first body line', () => {
      expect(stripQuotedReply('/approve now\n\nOn Tue, 14 Nov 2023 at 10:00, Conductor <c@x.test> wrote:\n> Approval needed\n> ...')).toBe('/approve now');
      expect(stripQuotedReply('Looks good\n-- \nSent from my phone')).toBe('Looks good');
      const mail = (subject: string, text: string) => ({ from: 'o@x.test', subject, text, authResults: '' });
      expect(inboundText(mail('Re: Fwd: /deny apr_1 too risky', 'whatever'))).toBe('/deny apr_1 too risky');
      expect(inboundText(mail('Re: [Conductor] Approval needed', '\n/approve apr_1\nthanks'))).toBe('/approve apr_1');
      expect(inboundText(mail('Question', 'How are we doing?\nSecond line'))).toBe('How are we doing?\nSecond line');
      expect(inboundText(mail('Only a subject', ''))).toBe('Only a subject');
    });
  });

  describe('gateway (SMTP out, IMAP in)', () => {
    let f: FakeServices;
    let imap: ImapMock;
    let gw: Gateways | null;
    let acme: Organization;

    const config = (extra: Record<string, unknown> = {}) => ({
      from: FROM,
      allowedChatIds: [OWNER_ADDR],
      smtp: { host: '127.0.0.1', port: smtp.port, allowInsecureAuth: true },
      imap: { host: '127.0.0.1', port: imap.port, secure: false, allowInsecureAuth: true, pollMs: 50 },
      ...extra,
    });
    const delivered = (needle: string) => waitFor(() => smtp.messages.find((m) => bodyOf(m.data).includes(needle)), `mail containing "${needle}"`);

    beforeEach(async () => {
      f = createFakeServices();
      imap = await startImapMock({ username: FROM, password: PASSWORD });
      gw = null;
      await f.k.secrets.set('mail', JSON.stringify({ password: PASSWORD }));
      acme = seedOrg(f.k, 'Acme');
      seedAgent(f.k, acme.id, seedDept(f.k, acme.id).id, 'Ada');
    });
    afterEach(async () => {
      await gw?.stop();
      await imap.close();
      f.dispose();
    });

    it('sends approvals as mail with reply-commands, and decides when the owner replies /approve', async () => {
      const row = insertGateway(f.k, { kind: 'email', orgId: acme.id, authRef: 'mail', config: config() });
      gw = await startGateways(f.services, { pollMs: 0 });
      expect(gw.status()).toEqual([{ id: row.id, kind: 'email', status: 'active', lastError: null }]);
      expect(imap.logins[0]).toEqual({ username: FROM, password: PASSWORD });

      const approval = f.requestApproval(acme.id, 'Send the proposal');
      await gw.idle();
      const mail = smtp.messages.at(-1)!;
      expect(mail).toMatchObject({ from: FROM, to: [OWNER_ADDR] });
      expect(mail.data).toContain('Subject: [Conductor] Approval needed: Send the proposal');
      expect(bodyOf(mail.data)).toContain(`Reply "/approve ${approval.id}" to approve, or "/deny ${approval.id} [note]" to deny.`);

      const uid = imap.deliver(inboundMail({ body: `/approve ${approval.id}\n\nOn Tue, Conductor wrote:\n> Approval needed: Send the proposal` }));
      await delivered('Approved: Send the proposal');
      expect(imap.seen.has(uid)).toBe(true);
      expect(f.decisions).toEqual([{ orgId: acme.id, approvalId: approval.id, decision: 'approved', by: { kind: 'human', id: 'owner' }, note: undefined }]);

      // A second reply is graceful, and plain text becomes a chat turn.
      imap.deliver(inboundMail({ subject: `/deny ${approval.id}`, body: '' }));
      await delivered('Already decided');
      imap.deliver(inboundMail({ subject: 'Question', body: 'How many issues closed today?' }));
      await delivered('echo: How many issues closed today?');
      expect(f.decisions).toHaveLength(1);
      expect(f.comments.map((c) => c.body)).toEqual(['How many issues closed today?', 'echo: How many issues closed today?']);
    });

    it('processes only allow-listed, authenticated senders — and never answers strangers', async () => {
      const row = insertGateway(f.k, { kind: 'email', orgId: acme.id, authRef: 'mail', config: config() });
      gw = await startGateways(f.services, { pollMs: 0 });
      const approval = f.requestApproval(acme.id, 'Wire the deposit');
      await gw.idle();
      const before = smtp.messages.length;

      const stranger = imap.deliver(inboundMail({ from: 'mallory@evil.test', body: `/approve ${approval.id}` }));
      const spoofed = imap.deliver(inboundMail({ body: `/approve ${approval.id}`, auth: 'dkim=fail; spf=softfail' }));
      const unsigned = imap.deliver(inboundMail({ body: `/approve ${approval.id}`, auth: null }));
      const legit = imap.deliver(inboundMail({ body: '/status' }));
      await delivered('Organization: Acme');
      expect([stranger, spoofed, unsigned, legit].every((uid) => imap.seen.has(uid))).toBe(true);
      expect(f.decisions).toHaveLength(0);
      expect(smtp.messages.length).toBe(before + 1);
      expect(smtp.messages.every((m) => m.to.join() === OWNER_ADDR)).toBe(true);
      const refused = f.k.audit.query({ action: 'gateway.message_refused' });
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({ entityId: row.id, data: { chatId: 'mallory@evil.test' } });
    });

    it('marks the gateway as error on bad IMAP credentials or an unreachable SMTP server', async () => {
      await f.k.secrets.set('mail-bad', JSON.stringify({ smtpPassword: PASSWORD, imapPassword: 'nope' }));
      const badImap = insertGateway(f.k, { kind: 'email', authRef: 'mail-bad', config: config() });
      const badSmtp = insertGateway(f.k, { kind: 'email', authRef: 'mail', config: config({ smtp: { host: '127.0.0.1', port: 1, allowInsecureAuth: true } }) });
      const invalid = insertGateway(f.k, { kind: 'email', authRef: 'mail', config: { from: 'nope' } });
      gw = await startGateways(f.services, { pollMs: 0 });
      const status = Object.fromEntries(gw.status().map((s) => [s.id, s]));
      expect(status[badImap.id]).toMatchObject({ status: 'error' });
      expect(status[badImap.id]!.lastError).toContain('IMAP LOGIN failed');
      expect(status[badImap.id]!.lastError).not.toContain('nope');
      expect(status[badSmtp.id]!.lastError).toContain('could not connect to 127.0.0.1:1');
      expect(status[invalid.id]).toMatchObject({ status: 'error' });
    });

    it('the IMAP client refuses plaintext logins unless explicitly allowed', async () => {
      await expect(fetchUnseen({ host: '127.0.0.1', port: imap.port, secure: false, username: FROM, password: PASSWORD })).rejects.toThrow(/without TLS is refused/);
      expect(imap.logins).toHaveLength(0);
    });
  });
});
