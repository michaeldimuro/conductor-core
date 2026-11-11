/** Public surface of the CLI context. `main.ts` is the executable entry; import from here in tests and tools. */
export { buildProgram, runCli, CLI_VERSION } from './program.js';
export { defaultDeps, type CliDeps, type CliFs, type LaunchdApi, type ExecResult } from './deps.js';
export { CliError, UsageError, EXIT } from './errors.js';
