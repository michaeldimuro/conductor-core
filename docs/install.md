# Installing, upgrading and removing Conductor

Conductor is distributed for macOS in two forms: an installer package (`.pkg`) and a Homebrew formula. Both put two commands on your `PATH`:

- `conductor` — the CLI
- `conductord` — the daemon (you rarely run it yourself; launchd does)

Neither form starts anything. The daemon is started, and set to start at every login, by `conductor install`, which you run once as the user who will own the agents.

## Requirements

- macOS on the architecture the package was built for. The `.pkg` file name carries it (`conductor-<version>-arm64.pkg`); the installer refuses the other architecture.
- Node.js 22 or newer.
  - Homebrew installs it as a dependency.
  - A `.pkg` either bundles its own Node runtime or uses the `node` on your `PATH` (falling back to `/opt/homebrew/bin/node`, then `/usr/local/bin/node`). The release notes for a given package say which; after installing, `/usr/local/lib/conductor/libexec/build.json` records it as `bundledNode`.
- `git` (skills are versioned with it). `conductor doctor` checks for it.

## Install with the package

1. Open `conductor-<version>-<arch>.pkg` and follow the installer.
2. The installer places the application in `/usr/local/lib/conductor` and writes `/usr/local/bin/conductor` and `/usr/local/bin/conductord`. It needs an administrator password for that. It does not create a launchd job, and it does not touch your home directory.

Continue with [First run](#first-run).

## Install with Homebrew

```sh
brew install OWNER/TAP/conductor
```

`OWNER/TAP` is a placeholder: use the tap named in the release notes. Homebrew installs Node if needed, then the application under its own prefix, and links `conductor` and `conductord`.

The formula has no `brew services` entry on purpose. The daemon runs under the launchd label `ai.conductor.daemon`, which `conductor install` manages; do not start it with `brew services`.

Continue with [First run](#first-run).

## First run

```sh
conductor install      # write and load the LaunchAgent; waits until the daemon answers
conductor doctor       # launchd, daemon, Keychain, provider logins, browser, tunnel
conductor quickstart   # first organization, first goal, first issue
conductor open         # sign in to the web UI at http://127.0.0.1:7420
```

What `conductor install` does:

- writes `~/Library/LaunchAgents/ai.conductor.daemon.plist` (`RunAtLoad`, `KeepAlive` on non-zero exit, `ThrottleInterval` 10) and loads it, so the daemon starts now, at every login, and again after a crash;
- writes a launcher at `~/.conductor/bin/conductord` that records the exact `node` and daemon entry point in use;
- sends daemon output to `~/Library/Logs/Conductor/`;
- creates the data directory `~/.conductor` on first start.

Options: `--port <n>` to use a port other than 7420, `--no-load` to write the plist without loading it. `conductor install --headless` is a different thing: see [headless.md](headless.md).

Things to know before `conductor quickstart`:

- **It starts real work.** A new organization begins working on its goal as soon as it exists, and that spends your provider quota. Use `conductor quickstart --no-run` to create everything without starting the first run, `conductor org kill` to stop one organization, or `conductor kill-switch on` to stop every run in every organization.
- **Provider.** Without `--provider`, quickstart looks for an installed `claude` CLI, then `codex`, then stored API keys. The default provider is `claude_local` (your Claude Code login). Choose explicitly with `--provider <adapter[:model]>`.
- **Browser.** Playwright's Chromium is not part of either package. Until it is installed, agents cannot use the browser; everything else works. `conductor doctor` reports its state on the `Playwright Chromium` line and prints the exact command to install it (it runs `npx playwright install chromium` from the application directory and downloads into your user cache, not into the application directory).
- **Owner token.** The CLI authenticates with `~/.conductor/owner.token`, a file readable only by you (mode 0600). Anyone who can read that file can control Conductor. It is a file rather than a Keychain item by the owner's decision.

Check the result at any time with `conductor status`; follow the daemon log with `conductor logs -f`.

## Upgrade

Your data (`~/.conductor`), logs and LaunchAgent are never touched by an upgrade. Database migrations are applied by the daemon when it starts. The daemon also writes a nightly database snapshot to `~/.conductor/backups/`.

### Package

Install the newer `.pkg` over the old one. The installer replaces `/usr/local/lib/conductor` completely. Then switch the running daemon to the new version:

```sh
conductor restart
conductor status       # the "daemon" line shows the running version
```

If the new package changed how Node is provided (bundled vs. your own), run `conductor install` instead of `conductor restart` so the launcher records the right `node`.

### Homebrew

```sh
brew upgrade conductor
conductor install
```

Run `conductor install` again after every `brew upgrade` of `conductor` **or of `node`**. The launcher written by `conductor install` records the versioned Homebrew Cellar paths of both; once Homebrew removes the old version, a daemon that restarts would not find them. Running `conductor install` again is safe: it rewrites the launcher and reloads the job.

## Uninstall

Stop the daemon and remove the LaunchAgent first. This keeps your data:

```sh
conductor uninstall
```

Then remove the application.

Package:

```sh
sudo rm -rf /usr/local/lib/conductor
sudo rm -f /usr/local/bin/conductor /usr/local/bin/conductord
sudo pkgutil --forget ai.conductor.pkg
```

Homebrew:

```sh
brew uninstall conductor
```

What is left, for you to keep or delete:

| Path | Contents |
| --- | --- |
| `~/.conductor/` | database, organizations, skills, memory, browser profiles, backups, owner token |
| `~/Library/Logs/Conductor/` | daemon logs |
| macOS Keychain | secrets stored with `conductor secret set` |
| `~/Library/Caches/ms-playwright/` | Playwright's Chromium, if you installed it |

## Known limits

- `conductor install` may replace a symlink at `/usr/local/bin/conductord` with a link to its own launcher when `/usr/local/bin` is writable by you. With the `.pkg` this never happens (the package installs a regular file there, which is left alone). With Homebrew on Intel Macs, where Homebrew's own link lives at that path, a later `brew upgrade conductor` can then stop at the link step; `brew link --overwrite conductor` resolves it.
- There is no `conductor` command that stops the daemon while keeping it installed. `conductor uninstall` followed later by `conductor install` is the supported way.
- Updates are not automatic: install a newer package or run `brew upgrade`.

## Building the packages (maintainers)

Both artifacts are built from a finished `npm run build` and start from the same `npm pack` tarball, so the `files` list in `package.json` is the single definition of what ships.

```sh
npm run build

# Installer package for this Mac's architecture
npm run package:pkg -- --out <dir> --sign "Developer ID Installer: <name> (<team id>)"

# Homebrew tarball + formula
npm run package:formula -- --out <dir> --url-base https://github.com/OWNER/REPO/releases/download/v<version> --homepage https://github.com/OWNER/REPO
```

`package:pkg`

- writes `<dir>/conductor-<version>-<arch>.pkg`;
- installs production dependencies with `npm ci --omit=dev` (needs the npm registry or a warm npm cache);
- bundles the `node` that runs the script when that binary links only against system libraries (a nodejs.org build). Homebrew's `node` cannot be bundled; the script says so and produces a package that uses the target Mac's Node. `--no-bundle-node` forces that;
- signs with the identity given by `--sign` or `CONDUCTOR_PKG_SIGN_IDENTITY`. Without one the package is unsigned and the script says so. Check a signed package with `pkgutil --check-signature <file>`;
- does not notarize. A signed package downloaded from the internet is still held by Gatekeeper until it is notarized; do that as a separate release step.

`package:formula`

- writes `<dir>/conductor-<version>.tgz` and `<dir>/conductor.rb`, whose `url` is `<url-base>/conductor-<version>.tgz` and whose `sha256` is that tarball's;
- uploads nothing. Publish the tarball at that URL, then put `conductor.rb` in the tap's `Formula/` directory;
- without `--url-base` it uses the placeholder `https://github.com/OWNER/conductor` and warns: that output is for inspection only.

Templates and installer scripts live in `packaging/`; their tests are in `tests/daemon/packaging.test.ts`.
