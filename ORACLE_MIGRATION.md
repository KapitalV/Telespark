# Oracle ARM64 migration — preparation and release gates

Preparation plan, 22 October 2026 (IST). This records the original migration
gates; see [Oracle operations](ORACLE_OPERATIONS.md) for completed inspections,
deployment paths, test evidence and remaining live acceptance checks.

## Verified local project

- Git: https://github.com/KapitalV/Telespark.git, branch `feature/otnew-poly`.
  Published application baseline: `fd7fd0460896805f39fd6e310132f7533fb5ddb9`.
- Source: `D:\electroshorts\outputs\telespark-publish-20261009`.
- Live configuration/data source: `D:\electroshorts\scholarship-telegram-bot`.
- Entry point `bot.mjs`; `npm start` runs Node with `.env` and IPv4-first DNS.
- Node requirement >=22; pinned Playwright 1.64.0, ExcelJS 4.4.0,
  pdfjs-dist 4.10.38. Install with the lockfile on Linux; never transfer Windows
  node_modules or browser caches.
- Confirmed present: `data/authorized-users.json`, `data/activity`,
  `data/saved-sessions`, `data/private/saved-session.key`.
  Preserve the ENTIRE saved-sessions tree, including hidden `.ids` reservations,
  encrypted profiles/results and the ORIGINAL encryption key.
- Each workflow opens an isolated browser context; sessions are temporary.
  SIGTERM/SIGINT trigger cleanup. The instance lock is machine-local: it cannot
  prevent Windows and Oracle from consuming the same token simultaneously.
- No shared browser-capacity limit currently exists. Telegram update dispatch is
  serial, but multiple users can retain live browsers while answering prompts.
  Implement/test a shared admission limit before allowing multi-user production
  traffic. Initial supervised test is one active workflow; 5–10 is not promised.
- Existing Dockerfile omits newer application modules. This plan uses native
  systemd, not that incomplete container image.

## 1. Inspect the VPS, read-only

Request the exact SSH connection command, username, host and local key-file path.
Do not request key contents or passwords in chat. Verify the SSH host key before
trusting a new host; never disable host-key checking.

In Ubuntu SSH run:

```bash
uname -m
cat /etc/os-release
nproc
free -h
lsblk -o NAME,SIZE,TYPE,MOUNTPOINTS
df -h / /dev/shm
```

`scripts/vps-inspect.sh` also reports installed Node/npm/Git/systemd versions
without reading secrets or changing the machine. If a command is unavailable,
record that fact; do not install packages until the inventory is reviewed.

## 2. Validate the browser/toolchain before migration

Prefer a currently supported Node 24 LTS release, installed from verified official
packages/binaries for the detected architecture. Confirm the final node executable
path before using the service template. Node's current status is documented at
https://nodejs.org/en/about/previous-releases .

The installed Playwright 1.64.0 package has Chromium and headless-shell download
entries for Ubuntu 22.04/24.04 ARM64. Official platform requirements include Linux
ARM64: https://playwright.dev/docs/intro . This is metadata evidence, not a live
VPS test. Match the detected OS to the PINNED package's support table first.

After provisioning a dedicated non-root `telespark` account and a separate code
release directory, install locked dependencies with `npm ci --omit=dev`. Inspect
optional native dependency installation on ARM64 (including PDF rendering support).
Run the project's local Playwright CLI `node node_modules/playwright/cli.js install
--dry-run chromium` first. Only after supported download targets are verified,
install its OS dependencies and browser as appropriate for the detected Ubuntu
release. Use `/var/cache/telespark/browsers`, owned by the application user, for
PLAYWRIGHT_BROWSERS_PATH. Do not substitute a browser or change selectors silently.

Run as the application user from the code directory:

```bash
node scripts/vps-browser-smoke.mjs
```

This uses synthetic offline content to test browser startup, context isolation,
screenshots and PDF generation/validation, and closes the browser. Expected result:
JSON with `result: passed`. It does not contact Telegram or the scholarship portal.
Also verify Hindi fonts and print layout on the target server before acceptance.

## 3. Prepare protected storage and a consistent transfer

Proposed layout (not yet installed):

| Path | Purpose |
| --- | --- |
| `/opt/telespark/releases/<commit>` | Root-managed code, readable by application user |
| `/opt/telespark/current` | Symlink to the selected release |
| `/etc/telespark/bot.env` | Private Node dotenv file, root:telespark 0640 |
| `/var/lib/telespark/data` | Migrated persistent state, telespark-owned, directories 0700/files 0600 |
| `/var/cache/telespark/browsers` | Installed ARM64 browser cache |

Inspect current custom path settings before packing anything. The inspected local
configuration uses the default data locations. Keep the full data tree together;
obsolete standalone runtime logs and caches need not migrate. Do not discard
activity history or ID reservations as if they were caches.

At the agreed cutover, first finish/cancel active workflows, stop the Windows bot,
verify zero Windows consumers, then make the final data snapshot. Keep Windows
stopped while transferring. Copy secrets and data through verified SSH/SCP into
a private staging directory; never commit them. Use per-file SHA-256 manifests
to compare the source snapshot and extracted destination without printing contents.
Exclude node_modules, Git metadata, temp/browser caches and obsolete runtime logs.

Do not overwrite an existing destination database or key. Back it up first, if
present, and investigate which copy is authoritative. Restore the original key
before any bot start. Verify existing encrypted records decrypt using SavedStore
without exposing field values. Missing data/key must fail the migration, not
initialize an empty production store. Preserve owner IDs and the access list.

## 4. Prepare the service, keep it stopped

`deploy/telespark.service.example` is a template requiring host validation. It
uses a dedicated user, private environment file, persistent state paths,
headless Chromium, polling, restart delay and graceful shutdown. It intentionally
requires `/etc/telespark/cutover-approved`; create this root-owned marker only
after the Windows consumer is stopped and all transfer/browser checks pass.
Do not enable the unit during package installation.

Review executable paths and validate with `systemd-analyze verify` on Ubuntu.
Set memory/task/CPU budgets only after measuring actual allocated resources and
the browser smoke test. Validate Chromium under the unit's restrictions too.
Configure bounded persistent journald storage; application activity logs are daily
files and need a separately agreed retention/archive policy. Never log credentials.

Polling needs outbound HTTPS/DNS and the local instance-lock socket; it needs no
public HTTP port, cron ping or webhook. Restrict OCI ingress and host firewall to
SSH from the administrator's verified source address. Confirm a second working
key-based SSH connection before disabling password/root login or modifying access
rules. Inspect existing rules before editing to avoid locking out the operator.

## 5. Controlled start and validation

After cutover approval and service installation, these are the Ubuntu controls:

```bash
sudo systemctl start telespark
sudo systemctl status telespark --no-pager
sudo journalctl -u telespark -f
sudo systemctl stop telespark
sudo systemctl restart telespark
```

Do not treat a running process as acceptance. Verify Telegram connectivity without
another getUpdates consumer, access denial, existing saved profiles/PDF retrieval,
CAPTCHA/OTP handoffs, all major workflows and print output with the user. No real
scholarship submission/locking during tests without explicit authorization.
Run default and intercepted-browser regression suites on ARM64. Browser fixtures
must stay offline. Test batch no-lock guarantees, shutdown cleanup, uncertain
submission protection and delivery retry.

Once accepted, `sudo systemctl enable telespark` enables boot startup; schedule a
supervised reboot and verify recovery. Benchmark one workflow first, then a shared
capacity limit of two, and increase only with CPU/RAM/disk/process measurements.
Until admission control is implemented and validated, keep testing supervised and
do not advertise 50-user production readiness.

## 6. Updates, backup and rollback

Keep immutable code releases, install dependencies per release, and retain previous
release pointers. Stop the sole consumer before switching code. Never reset the
live data directory or rotate its encryption key during an application update.
Back up a consistent stopped data tree together with the key and private config;
encrypt backups separately with restricted access and test restoration.

For rollback after Oracle has accepted writes, stop Oracle first and transfer its
LATEST consistent data/key snapshot back to the chosen runtime. Do not restart
Windows against a stale pre-migration copy: it can lose records or reuse IDs.
Unknown portal submissions must remain unknown; do not replay them after restart.

## Historical preparation boundary

The sections above record the original migration gates. The VPS has since been
inspected, code/configuration/data transferred, and the service configured and
tested. See [ORACLE_OPERATIONS.md](ORACLE_OPERATIONS.md) for the installed layout,
measured capacity, current verification results and remaining live-portal checks.
