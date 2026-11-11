import { Command, CommanderError } from 'commander';
import type { CliDeps } from './deps.js';
import { Ctx, DEFAULT_PORT } from './context.js';
import { CliError, EXIT, SilentExit, toCliError } from './errors.js';
import { colourEnabled, makeStyle } from './output.js';
import { daemonCommands } from './commands/daemon.js';
import { doctorCommand } from './commands/doctor.js';
import { orgCommands } from './commands/org.js';
import { agentCommands } from './commands/agent.js';
import { workCommands } from './commands/work.js';
import { runCommands } from './commands/run.js';
import { governanceCommands } from './commands/governance.js';
import { skillCommands } from './commands/skills.js';
import { memoryCommands } from './commands/memory.js';
import { connectorCommands } from './commands/connector.js';
import { quickstartCommand } from './commands/quickstart.js';
import { browserCommands } from './commands/browser.js';
import { playbookCommands } from './commands/playbook.js';
import { revisionCommands } from './commands/revisions.js';
import { authCommands } from './commands/auth.js';

export const CLI_VERSION = '0.1.0';

/**
 * The `conductor` command tree. Everything that touches the outside world
 * (API client, filesystem, launchd, subprocesses, terminal) comes from `deps`,
 * so tests drive the real commands against fakes.
 */
export function buildProgram(deps: CliDeps): Command {
  const program = new Command('conductor');
  program
    .description('Conductor — run organizations of AI agents on your Mac.\n\nNew here? `conductor install`, then `conductor quickstart`.')
    .version(CLI_VERSION, '-V, --version')
    .option('--json', 'machine-readable JSON output')
    .option('--home <dir>', 'Conductor home directory (default ~/.conductor, or $CONDUCTOR_HOME)')
    .option('--url <base>', `daemon base URL (default http://127.0.0.1:${DEFAULT_PORT}, or $CONDUCTOR_PORT)`)
    .option('--org <slug|id>', 'organization to act on (default: `conductor org use`, or the only org)')
    // Settings below are inherited by every subcommand created afterwards.
    .exitOverride()
    .configureOutput({
      writeOut: (text) => deps.stdout(text),
      writeErr: (text) => deps.stderr(text),
      getOutHasColors: () => colourEnabled(deps.isTTY, deps.env),
      getErrHasColors: () => false,
    })
    .showSuggestionAfterError(true);

  daemonCommands(program, deps);
  quickstartCommand(program, deps);
  doctorCommand(program, deps);
  orgCommands(program, deps);
  agentCommands(program, deps);
  workCommands(program, deps);
  runCommands(program, deps);
  governanceCommands(program, deps);
  skillCommands(program, deps);
  memoryCommands(program, deps);
  connectorCommands(program, deps);
  browserCommands(program, deps);
  playbookCommands(program, deps);
  revisionCommands(program, deps);
  authCommands(program, deps);
  return program;
}

/** Global flags as typed on the command line, for error reporting before/without a parsed command. */
function peekGlobals(argv: string[]): { json: boolean; home?: string; url?: string } {
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    if (i !== -1) return argv[i + 1];
    return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  return { json: argv.includes('--json'), home: value('--home'), url: value('--url') };
}

function report(deps: CliDeps, err: CliError, json: boolean): void {
  if (err instanceof SilentExit || (!err.message && err.hints.length === 0)) return;
  if (json) {
    deps.stderr(`${JSON.stringify({ error: { code: err.code, message: err.message, ...(err.hints.length ? { hints: err.hints } : {}) } })}\n`);
    return;
  }
  const s = makeStyle(colourEnabled(deps.isTTY, deps.env));
  deps.stderr(`${s.red('error:')} ${err.message}\n`);
  for (const hint of err.hints) deps.stderr(hint.startsWith('  ') ? `${hint}\n` : `  ${s.dim('→')} ${hint}\n`);
}

/**
 * Parse and run one invocation. Returns the process exit code:
 * 0 ok · 1 failure · 2 usage (bad flags/arguments, validation errors).
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const program = buildProgram(deps);
  const globals = peekGlobals(argv);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help and --version are successful outcomes; commander already printed everything else.
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') return EXIT.ok;
      return EXIT.usage;
    }
    const baseUrl = new Ctx(deps, globals).baseUrl;
    const cliError = toCliError(err, baseUrl);
    report(deps, cliError, globals.json);
    return cliError.exitCode;
  }
}
