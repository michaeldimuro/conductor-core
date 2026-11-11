import { execFile } from 'node:child_process';
import { ConductorError } from '../shared/errors.js';

export interface OnePasswordOptions {
  /** `op` binary (default: `$CONDUCTOR_OP_BIN`, else `op` on PATH). */
  bin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** `op://<vault>/<item>/[<section>/]<field>` — 1Password's secret reference syntax. */
const OP_REF_RE = /^op:\/\/([^/\n\r\0]+)\/([^/\n\r\0]+)\/([^\n\r\0]+)$/;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_VALUE_BYTES = 1024 * 1024;

export const isOpReference = (value: string): boolean => value.startsWith('op://');

/** The vault a reference points into, or null when it is not a well-formed reference. */
export function opVault(ref: string): string | null {
  if (ref.length > 500) return null;
  return OP_REF_RE.exec(ref)?.[1] ?? null;
}

const LOCKED_RE = /not (currently )?signed in|sign ?in|session expired|is locked|locked|authorization (prompt|denied|timeout|failed)|biometric|no accounts? configured|connect(ing)? to (the )?desktop app|unlock/i;
const MISSING_RE = /isn't an? (item|vault|field)|is not an? (item|vault|field)|could ?n[o']t find|not found|no item|does ?n[o']t exist|doesn't have a field/i;

function failure(message: string): ConductorError {
  return new ConductorError('unavailable', message);
}

/**
 * Read one secret through the 1Password CLI (`op read --no-newline <ref>`).
 * Fails closed with a message that names the cause but never the value: stdout
 * is the secret and is returned to the caller only; stderr is classified, not echoed.
 */
export function readOnePassword(ref: string, opts: OnePasswordOptions = {}): Promise<string> {
  if (opVault(ref) === null) return Promise.reject(new ConductorError('validation', '1Password references look like op://<vault>/<item>/<field>'));
  const bin = opts.bin ?? process.env.CONDUCTOR_OP_BIN ?? 'op';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(bin, ['read', '--no-newline', ref], {
      timeout: timeoutMs, maxBuffer: MAX_VALUE_BYTES, encoding: 'utf8', windowsHide: true,
      env: { ...(opts.env ?? process.env), NO_COLOR: '1' },
    }, (err, stdout, stderr) => {
      if (!err) {
        if (stdout.length === 0) return reject(failure('1Password returned an empty value for that reference'));
        return resolve(stdout);
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (e.code === 'ENOENT' || e.code === 'EACCES') {
        return reject(failure('the 1Password CLI (`op`) is not installed on this Mac. Install it (brew install 1password-cli) and turn on "Integrate with 1Password CLI" in the 1Password app.'));
      }
      if (e.killed || e.signal) {
        return reject(failure('1Password did not answer in time; it is probably locked and waiting for you. Unlock the 1Password app and try again.'));
      }
      const text = String(stderr ?? '');
      if (LOCKED_RE.test(text)) return reject(failure('1Password is locked or not signed in. Unlock the 1Password app (or run `op signin`) and try again.'));
      if (MISSING_RE.test(text)) return reject(failure('1Password has no item or field at that reference'));
      reject(failure(`the 1Password CLI failed (exit code ${typeof e.code === 'number' ? e.code : 'unknown'}); run \`op read\` with the same reference in a terminal to see why`));
    });
  });
}
