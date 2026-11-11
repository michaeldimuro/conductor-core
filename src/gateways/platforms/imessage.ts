import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { errorMessage } from '../../shared/errors.js';
import type { AdapterContext, GatewayAdapter, OutboundMessage } from '../types.js';
import { hasLineBreak } from '../util.js';

const imessageConfig = z.looseObject({
  /** Defaults to ~/Library/Messages/chat.db. */
  chatDbPath: z.string().min(1).optional(),
  /** Defaults to /usr/bin/osascript. */
  osascriptPath: z.string().min(1).optional(),
  pollMs: z.number().int().min(50).max(600_000).default(3_000),
});

/**
 * The recipient and the text travel as argv to `on run` — they are never
 * interpolated into the script source, so message text cannot become AppleScript.
 */
export const SEND_SCRIPT = [
  'on run argv',
  '  set targetHandle to item 1 of argv',
  '  set messageText to item 2 of argv',
  '  tell application "Messages"',
  '    set targetService to 1st account whose service type = iMessage',
  '    send messageText to participant targetHandle of targetService',
  '  end tell',
  'end run',
].join('\n');

/**
 * Newer macOS versions leave `message.text` NULL and store the text in
 * `attributedBody`, an NSAttributedString typedstream. The string payload
 * follows the NSString class marker: 0x2B, a length (1 byte, or 0x81 + u16 LE,
 * or 0x82 + u32 LE), then UTF-8.
 */
export function textFromAttributedBody(blob: Buffer | null | undefined): string | null {
  if (!blob || blob.length === 0) return null;
  const marker = blob.indexOf('NSString');
  if (marker < 0) return null;
  let i = blob.indexOf(0x2b, marker + 8);
  if (i < 0 || i + 1 >= blob.length) return null;
  i += 1;
  let length = blob[i]!;
  i += 1;
  if (length === 0x81) {
    if (i + 2 > blob.length) return null;
    length = blob.readUInt16LE(i);
    i += 2;
  } else if (length === 0x82) {
    if (i + 4 > blob.length) return null;
    length = blob.readUInt32LE(i);
    i += 4;
  }
  if (length <= 0 || i + length > blob.length) return null;
  return blob.subarray(i, i + length).toString('utf8');
}

interface MessageRow {
  rowid: number;
  text: string | null;
  attributedBody: Buffer | null;
  handle: string | null;
}

/**
 * iMessage through a local bridge on the Mac that runs the daemon.
 *
 * Receiving polls ~/Library/Messages/chat.db read-only. macOS protects that
 * file: the process running conductord (or the terminal / launchd agent that
 * starts it) must be granted **Full Disk Access** in System Settings →
 * Privacy & Security, otherwise the open fails and the gateway is marked
 * `error`. Sending drives Messages.app through `osascript`, which needs the
 * Automation permission for Messages the first time it runs.
 *
 * Only rows from allow-listed handles are ever read into the router, and
 * strangers are never answered.
 */
export function createIMessageAdapter(ctx: AdapterContext): GatewayAdapter {
  let chatDbPath = join(homedir(), 'Library', 'Messages', 'chat.db');
  let osascriptPath = '/usr/bin/osascript';
  let timer: NodeJS.Timeout | null = null;
  let lastRowId = 0;
  let busy = false;

  function open(): Database.Database {
    try {
      return new Database(chatDbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      throw new Error(`cannot read the Messages database at ${chatDbPath} (${errorMessage(err)}). Grant Full Disk Access to the process running conductord in System Settings → Privacy & Security.`, { cause: err });
    }
  }

  function allowedHandles(): Set<string> {
    const cfg = ctx.config();
    return new Set([...cfg.allowedChatIds, ...cfg.allowedUserIds].map((h) => h.toLowerCase()));
  }

  function poll(): void {
    const db = open();
    let rows: MessageRow[];
    try {
      rows = db.prepare(
        `SELECT m.ROWID AS rowid, m.text AS text, m.attributedBody AS attributedBody, h.id AS handle
           FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id
          WHERE m.ROWID > ? AND m.is_from_me = 0
          ORDER BY m.ROWID ASC LIMIT 100`,
      ).all(lastRowId) as MessageRow[];
    } finally {
      db.close();
    }
    if (rows.length === 0) return;
    const allowed = allowedHandles();
    for (const row of rows) {
      lastRowId = Math.max(lastRowId, row.rowid);
      const handle = row.handle?.trim();
      const text = row.text ?? textFromAttributedBody(row.attributedBody);
      // Anyone can text a phone number: everything not from an allow-listed handle is ignored outright.
      if (!handle || !text || !allowed.has(handle.toLowerCase())) continue;
      void ctx.emit({ chatId: handle, userId: handle, text, isGroup: false }).catch((err) => {
        ctx.log.warn({ gatewayId: ctx.gatewayId, err: errorMessage(err) }, 'imessage handling failed');
      });
    }
    ctx.setState('imessageRowId', lastRowId);
  }

  return {
    kind: 'imessage',
    maxLength: 4000,
    buttons: false,
    quietRefusals: true,

    async start() {
      const cfg = imessageConfig.parse(ctx.config());
      chatDbPath = cfg.chatDbPath ?? chatDbPath;
      osascriptPath = cfg.osascriptPath ?? osascriptPath;

      const stored = ctx.getState('imessageRowId');
      if (typeof stored === 'number' && Number.isFinite(stored)) {
        lastRowId = stored;
        open().close();
      } else {
        // First start: begin at the newest message instead of replaying history.
        const db = open();
        try {
          const row = db.prepare('SELECT COALESCE(MAX(ROWID), 0) AS max FROM message').get() as { max: number };
          lastRowId = row.max;
        } catch (err) {
          throw new Error(`the Messages database at ${chatDbPath} is not readable as chat.db: ${errorMessage(err)}`, { cause: err });
        } finally {
          db.close();
        }
        ctx.setState('imessageRowId', lastRowId);
      }

      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        try {
          poll();
          ctx.health(null);
        } catch (err) {
          ctx.health(errorMessage(err));
        } finally {
          busy = false;
        }
      }, cfg.pollMs);
      timer.unref();
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },

    send(chatId: string, message: OutboundMessage): Promise<void> {
      const handle = chatId.trim();
      if (!handle || handle.length > 254 || hasLineBreak(handle)) return Promise.reject(new Error('invalid iMessage handle'));
      return new Promise((resolve, reject) => {
        // execFile: no shell. `--` is not needed: osascript treats everything after the script as argv.
        execFile(osascriptPath, ['-e', SEND_SCRIPT, handle, message.text], { timeout: 30_000 }, (err, _stdout, stderr) => {
          if (err) reject(new Error(`osascript failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
          else resolve();
        });
      });
    },
  };
}
