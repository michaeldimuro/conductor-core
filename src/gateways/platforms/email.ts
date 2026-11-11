import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { errorMessage } from '../../shared/errors.js';
import type { AdapterContext, GatewayAdapter, OutboundMessage } from '../types.js';
import { fetchUnseen, type ImapOptions } from './imap.js';
import { buildMessage, isEmailAddress, parseMail, type ParsedMail } from './mime.js';
import { sendMail, verifySmtp, type SmtpOptions } from './smtp.js';

const emailConfig = z.looseObject({
  /** The gateway's own address (envelope sender and From). */
  from: z.string().refine(isEmailAddress, 'from must be an email address'),
  smtp: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().optional(),
    username: z.string().max(320).optional(),
    allowInsecureAuth: z.boolean().default(false),
    rejectUnauthorized: z.boolean().default(true),
  }),
  imap: z.object({
    host: z.string().min(1).max(255),
    port: z.number().int().min(1).max(65535).default(993),
    secure: z.boolean().default(true),
    username: z.string().max(320).optional(),
    mailbox: z.string().min(1).max(200).default('INBOX'),
    pollMs: z.number().int().min(50).max(3_600_000).default(60_000),
    allowInsecureAuth: z.boolean().default(false),
    rejectUnauthorized: z.boolean().default(true),
  }).optional(),
  /**
   * A From header is trivially forged. By default inbound mail is only
   * accepted when the receiving mail server vouched for the sender in
   * Authentication-Results (DMARC, DKIM or SPF pass).
   */
  requireAuthenticatedSender: z.boolean().default(true),
});

function senderAuthenticated(mail: ParsedMail): boolean {
  return /\b(dmarc|dkim|spf)=pass\b/i.test(mail.authResults);
}

/**
 * Inbound email is untrusted text. A command is taken from the subject (after
 * Re:/Fwd: prefixes) or the first line of the body; otherwise the body, with
 * the quoted original stripped, is a chat message.
 */
export function inboundText(mail: ParsedMail): string {
  const subject = mail.subject.replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, '').trim();
  if (subject.startsWith('/')) return subject;
  const firstLine = mail.text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  if (firstLine.startsWith('/')) return firstLine;
  return mail.text || subject;
}

/**
 * Email: SMTP out, IMAP polling in — both spoken directly over node:net/tls.
 * No buttons: approvals carry `/approve <id>` reply-commands instead. The
 * chat id is the correspondent's address; strangers are never answered.
 */
export function createEmailAdapter(ctx: AdapterContext): GatewayAdapter {
  let from = '';
  let smtp: SmtpOptions | null = null;
  let imap: ImapOptions | null = null;
  let requireAuthenticatedSender = true;
  let timer: NodeJS.Timeout | null = null;
  let polling: Promise<void> | null = null;
  let stopped = false;

  async function pollOnce(): Promise<void> {
    if (!imap) return;
    const messages = await fetchUnseen(imap);
    for (const raw of messages) {
      const mail = parseMail(raw);
      if (!mail.from) continue;
      if (mail.from === from.toLowerCase()) continue; // our own mail looping back
      if (requireAuthenticatedSender && !senderAuthenticated(mail)) {
        ctx.log.warn({ gatewayId: ctx.gatewayId }, 'email gateway dropped a message whose sender was not authenticated');
        continue;
      }
      const text = inboundText(mail);
      if (!text) continue;
      // The router enforces the sender allow-list (and audits refusals).
      await ctx.emit({ chatId: mail.from, userId: mail.from, text, isGroup: false }).catch((err) => {
        ctx.log.warn({ gatewayId: ctx.gatewayId, err: errorMessage(err) }, 'email message handling failed');
      });
    }
  }

  function schedule(pollMs: number): void {
    timer = setInterval(() => {
      if (polling || stopped) return;
      polling = pollOnce()
        .then(() => ctx.health(null), (err) => ctx.health(errorMessage(err)))
        .finally(() => {
          polling = null;
        });
    }, pollMs);
    timer.unref();
  }

  return {
    kind: 'email',
    maxLength: 100_000,
    buttons: false,
    quietRefusals: true,

    async start() {
      const cfg = emailConfig.parse(ctx.config());
      from = cfg.from;
      requireAuthenticatedSender = cfg.requireAuthenticatedSender;
      const fallback = ctx.credentials.password ?? ctx.credentials.token;
      const smtpPassword = ctx.credentials.smtpPassword ?? fallback;
      smtp = {
        host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure ?? cfg.smtp.port === 465,
        username: smtpPassword ? cfg.smtp.username ?? cfg.from : cfg.smtp.username,
        password: smtpPassword,
        allowInsecureAuth: cfg.smtp.allowInsecureAuth, rejectUnauthorized: cfg.smtp.rejectUnauthorized,
      };
      await verifySmtp(smtp);
      if (cfg.imap) {
        const imapPassword = ctx.credentials.imapPassword ?? fallback;
        if (!imapPassword) throw new Error('email gateway has IMAP configured but no password in the secret store');
        imap = {
          host: cfg.imap.host, port: cfg.imap.port, secure: cfg.imap.secure, username: cfg.imap.username ?? cfg.from, password: imapPassword,
          mailbox: cfg.imap.mailbox, allowInsecureAuth: cfg.imap.allowInsecureAuth, rejectUnauthorized: cfg.imap.rejectUnauthorized,
        };
        await pollOnce(); // fail fast on bad credentials
        schedule(cfg.imap.pollMs);
      }
    },

    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      await polling?.catch(() => {});
    },

    async send(chatId: string, message: OutboundMessage) {
      if (!smtp) throw new Error('email gateway is not started');
      const to = chatId.trim().toLowerCase();
      if (!isEmailAddress(to)) throw new Error('recipient is not an email address');
      const firstLine = message.text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? 'Message';
      const subject = `[Conductor] ${(message.subject ?? firstLine).slice(0, 150)}`;
      const data = buildMessage({
        from, to, subject, text: message.text, date: new Date(ctx.now()),
        messageId: `${randomUUID()}@${from.split('@')[1] ?? 'conductor.local'}`,
      });
      await sendMail(smtp, { from, to, data });
    },
  };
}
