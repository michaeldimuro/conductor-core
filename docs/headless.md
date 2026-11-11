# Advanced: boot without login (headless LaunchDaemon)

The normal install (`conductor install`) is a per-user **LaunchAgent**. It starts when you log in, because agents need your login Keychain, your browser and your GUI session. For most Macs, enabling automatic login is the simpler way to have Conductor running after a reboot.

This page covers the alternative for a Mac that must run agents after a reboot with **nobody logged in**: a system **LaunchDaemon** running a headless profile. It is an advanced setup with real trade-offs. Conductor never installs it for you: it prints the property list and the commands, and an administrator runs them.

## What you give up

| | LaunchAgent (default) | Headless LaunchDaemon |
| --- | --- | --- |
| Starts | at login | at boot |
| Secrets | macOS Keychain | encrypted file `~/.conductor/vault.enc` |
| GUI session | yes | none |
| Managed by `conductor install` / `restart` / `uninstall` / `status` | yes | no (`launchctl`, with `sudo`) |

Consequences:

- **No Keychain.** Secrets you stored under the LaunchAgent are in your login Keychain and are not visible to the headless daemon. Store them again once it is running (`conductor secret set <ref>`); they then go into the vault.
- **Provider logins.** A provider CLI that keeps its login in the login Keychain cannot authenticate without a login session. Plan on API-key providers (`claude_api`, `openai_api`) with keys in the vault, and confirm any local-CLI provider with `conductor adapter test <id>` after a reboot, before relying on it.
- **No visible browser.** There is no display, so a browser profile set to headed mode cannot open a window. Keep browser profiles headless. The plist sets `CONDUCTOR_HEADLESS=1`, but in this version the daemon does not read it: nothing switches headed profiles to headless for you.
- **The vault key is a file.** The vault is encrypted with AES-256-GCM; its passphrase is stored in `~/.conductor/vault.key`, readable only by the service user. Anyone who obtains both files can decrypt the secrets. Back the key up somewhere safe: without it the vault cannot be opened.
- **CLI lifecycle commands do not apply.** `conductor status` and `conductor doctor` look at the per-user LaunchAgent and will report launchd as not installed even though the daemon answers. `conductor restart` and `conductor uninstall` do not act on the LaunchDaemon. Everything else in the CLI and the web UI works as usual, because it talks to the daemon over its API.

## Before you start

- Install Conductor ([install.md](install.md)) and run every command below as the user who should own the agents and the data. That user becomes the daemon's `UserName`.
- Run **one** daemon per data directory. If the LaunchAgent is installed, remove it first; your data is kept:

  ```sh
  conductor uninstall
  ```

- Homebrew on an Intel Mac only: `/usr/local/bin/conductord` is Homebrew's symlink into its Cellar, and step 1 below would write through it. Remove the symlink first: `sudo rm /usr/local/bin/conductord`.

## Setup

1. Generate the property list and the exact commands for this machine:

   ```sh
   conductor install --headless --out ai.conductor.daemon.headless.plist
   ```

   This writes the plist to the named file and prints six numbered steps. It installs nothing and needs no `sudo`. Without `--out` the plist is printed instead of saved. Add `--json` for machine-readable output (`plist`, `target`, `steps`).

2. Read the plist. It should contain:

   - `Label` `ai.conductor.daemon.headless`
   - `ProgramArguments` `/usr/local/bin/conductord --serve`
   - `UserName` — your user
   - `RunAtLoad`, `KeepAlive` (restart on non-zero exit), `ThrottleInterval` 10
   - `EnvironmentVariables`: `CONDUCTOR_HOME`, `CONDUCTOR_LOG_DIR`, `CONDUCTOR_SECRETS=vault`, `CONDUCTOR_VAULT_KEY_FILE` (the path of `vault.key`), `CONDUCTOR_HEADLESS=1`, plus `PATH`, `HOME` and `LANG`

   The vault passphrase itself is never in the plist.

3. Run the printed steps in order, exactly as printed (they contain the paths for your machine). They do the following:

   | Step | What it does |
   | --- | --- |
   | 1 | writes the launcher `/usr/local/bin/conductord` (with `sudo`), which runs the recorded `node` with the installed daemon |
   | 2 | creates the data and log directories |
   | 3 | creates `vault.key` with a random passphrase, readable only by you |
   | 4 | copies the plist to `/Library/LaunchDaemons/ai.conductor.daemon.headless.plist`, owned by `root:wheel`, mode 644 |
   | 5 | loads it: `sudo launchctl bootstrap system /Library/LaunchDaemons/ai.conductor.daemon.headless.plist` |
   | 6 | checks the daemon: `curl -fsS http://127.0.0.1:7420/healthz` should answer within 30 seconds |

   Step 3 overwrites an existing `vault.key`. If you already have a vault, skip step 3, or its contents become unreadable.

4. Store the secrets the agents need, then check the providers:

   ```sh
   conductor secret set <ref>
   conductor adapter test <id>
   ```

5. Reboot and, without logging in, confirm from another device or over SSH that `/healthz` answers.

## Operating it

```sh
# restart
sudo launchctl kickstart -k system/ai.conductor.daemon.headless

# state
sudo launchctl print system/ai.conductor.daemon.headless

# logs
conductor logs -f
```

After upgrading Conductor ([install.md](install.md#upgrade)):

- `.pkg`: the installer rewrites `/usr/local/bin/conductord` with the package's own launcher, which is equally valid. Restart the daemon with the `kickstart` command above.
- Homebrew: the launcher from step 1 records versioned Cellar paths. Generate the steps again (`conductor install --headless --out …`), repeat **step 1 only**, then `kickstart`.

## Removing it

```sh
sudo launchctl bootout system/ai.conductor.daemon.headless
sudo rm /Library/LaunchDaemons/ai.conductor.daemon.headless.plist
```

Your data, the vault and its key stay in `~/.conductor`. To go back to the normal setup, run `conductor install`. Secrets in the vault are not copied to the Keychain; store them again.
