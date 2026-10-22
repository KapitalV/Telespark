# Oracle VPS operations and validation

Migration date: **22 October 2026 (IST)**. Read alongside [master.md](master.md).
The service and saved data are separate from the code release. Never publish the
environment file, saved records, application encryption key or backup recovery key.

## Installed layout

- Ubuntu 22.04.5 ARM64, 2 CPU cores, approximately 12 GB RAM, 46.6 GB boot disk.
- Node 24.22.1; locked npm dependencies; Playwright 1.64.0 ARM64 Chromium.
- Application release: `/opt/telespark/releases/fd7fd04-vps1` (baseline Git commit
  fd7fd04 plus migration capacity controls). Code is root-owned and read-only to
  the service user. The previous `/opt/telespark/releases/fd7fd04` remains available.
- Unit: `/etc/systemd/system/telespark.service`, with overrides in
  `/etc/systemd/system/telespark.service.d/10-oracle.conf`.
- Secret environment file: `/etc/telespark/bot.env`, root:telespark 0640.
- State: `/var/lib/telespark/data`, directories 0700 and files 0600.
- Original key: `/var/lib/telespark/data/private/saved-session.key`.
- Browser cache: `/var/cache/telespark/browsers`.
- Activity history remains in `data/activity`; system journal is persistent and
  configured for 250 MB / 30 days. Existing activity history is not deleted.
- Windows `.env` now has `BOT_DISABLED=true`; its normal startup exits before
  contacting Telegram. Do not remove this until Oracle is stopped and its latest
  state has been reconciled. Machine-local instance locks cannot coordinate hosts.

## Operator commands (Ubuntu SSH)

```bash
systemctl status telespark --no-pager
journalctl -u telespark -n 50 --no-pager
journalctl -u telespark -f
systemctl stop telespark
systemctl start telespark
systemctl restart telespark
systemctl is-enabled telespark
systemctl show telespark -p MainPID -p NRestarts -p MemoryCurrent -p TasksCurrent
free -h
df -h /
```

Use root SSH for administration, but the bot runs as `telespark`. Password/root SSH
access remains unchanged at the owner's explicit request. Replace the password
shared in chat and consider key-based non-root administration separately; do not
claim this deployment has completed that hardening. No SSH key was authorized or
installed by this migration. OCI NSG access has not been independently inspected.
The existing IPv4 host firewall accepts SSH and rejects other unsolicited ingress;
no global IPv6 address was present at inspection. Polling needs no public web port.

## Bounded concurrency

`MAX_ACTIVE_BROWSERS` accepts 1–10 and defaults to 2. The VPS overrides it to 5.
All six portal factories (including sequential batch printing) share that cap.
Additional browser starts queue FIFO in memory, at most 50 requests and 20 seconds
per request. Users are notified while waiting. If no slot frees in time, the normal
module error/retry path applies; the bot does not replay portal submissions.
`/cancel` and `/menu` abort that user's pending browser lease. Idle active sessions
still expire using the existing 20-minute rules. The queue does not survive restart.

Polling dispatch now allows work across chats concurrently while the existing
router preserves each chat's message order and duplicate checks. Dispatch is bounded
at 200 pending messages and 10 per chat; overflow starts no portal work and is logged
without answers. Webhook dispatch retains its existing sequential behavior.
Browser slots release on close/crash, pending launches cancel on shutdown, and
late-created browsers close after cancellation. The unit applies 6 GB memory-high,
8 GB maximum and 1024 tasks as host safeguards, not capacity guarantees.

## Test evidence and limits

- 295 unit/intercepted-browser tests passed on ARM64, zero failures/skips.
- 100 transferred files matched the original archive byte-for-byte before startup.
- Original saved records and access store authenticated successfully.
- Offline browser/PDF smoke test passed; contexts are isolated.
- The same browser smoke test passed under the systemd service restrictions.
- Telegram authenticated and accepted a synthetic PDF in the configured admin's
  private chat. This tests transport; it does not validate a real applicant PDF.
- Forced main-process failure recovered automatically after the configured delay,
  and the replacement process connected to Telegram.
- Reboot recovery passed on 22 October 2026: the boot ID changed, the enabled
  service started automatically, and exactly one bot process ran as `telespark`.
  Telegram authentication passed again after reboot. One polling interruption was
  recorded; the bot's reconnect loop remains enabled. This is not an uptime SLA.
- Sustained five-browser test: 150 workflows, zero errors, 193 seconds, workflow
  p95 6.55 seconds (including a five-second simulated human wait), average CPU
  21.1%, and at least 10802 MiB available RAM. All browser processes closed.
- Initial synthetic workload: three waves at each concurrency, fresh browser per
  workflow, dependent dropdowns, screenshots, 2-second human wait, two-page PDF.

| Concurrent browsers | Completed | Errors | Workflow p95 | Minimum available RAM |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 3 | 0 | 2.81 s | 11183 MiB |
| 2 | 6 | 0 | 2.74 s | 11115 MiB |
| 3 | 9 | 0 | 2.96 s | 11029 MiB |
| 5 | 15 | 0 | 3.35 s | 10898 MiB |
| 8 | 24 | 0 | 4.09 s | 10691 MiB |
| 10 | 30 | 0 | 4.51 s | 10551 MiB |

These are lightweight offline fixtures, not scholarship-site performance or a
promise of 10 live applicants. Human CAPTCHA waits, portal latency, larger PDFs and
real page scripts change capacity. Five is an initial operating limit with headroom.
The capacity script refuses >10 and stops on failures or <2 GB available RAM.

Run mock tests only while the production bot is stopped or in a separate test
environment. Do not load-test the government portal or send bulk OTPs.

```bash
cd /opt/telespark/releases/fd7fd04-vps1
runuser -u telespark -- env PLAYWRIGHT_BROWSERS_PATH=/var/cache/telespark/browsers \
  CAPACITY_LEVELS=1,2,3,5 CAPACITY_ROUNDS=3 node scripts/vps-capacity.mjs
```

Live applicant acceptance still requires the authorized user: saved-user login,
CAPTCHA/OTP handoff, Fresh/Renewal and OBC field review, check/final print, and batch
delivery. Do not submit/lock real applications simply to test the migration.

At cutover, the official Fresh/Renewal login and OTR pages timed out from the VPS;
an actual Playwright navigation also timed out. The Windows HTTPS probe reported
a revoked certificate. These are different observations and do not establish a
single cause or an Oracle-specific block. Do not disable TLS verification or
change portal selectors to hide this. Live portal acceptance remains pending
until normal HTTPS access is available.

## Backup, restore and rollback

With the bot stopped, run as root:

```bash
cd /opt/telespark/releases/fd7fd04-vps1
node scripts/vps-backup.mjs
```

The utility creates a unique authenticated AES-256-GCM archive in
`/root/telespark-backups`. It backs up the entire data tree and private environment,
authenticates a round-trip decryption and checks the restored tar listing in memory.
It never overwrites existing archives. Recovery key: `/root/telespark-backup.key`,
0600, separate from the archive and original application key. Keep a protected
off-host copy of the backup and its recovery key in separate locations. A same-disk
backup alone does not protect against loss of the VPS.

A cutover backup was copied to the Windows private backup directory and its
recovery key to a separate user-only recovery directory. Off-host authenticated
decryption passed without extracting applicant records. Paths are in the private
operator handoff; neither file belongs in Git. Back up again after new records
are created. Backups are manual; no recurring task was silently scheduled.

Envelope format: `TSPBK001` (8 bytes), IV (12), authentication tag (16), ciphertext.
Restore must authenticate AES-256-GCM before extracting into a NEW private staging
directory. Inspect the staging tree before replacing any live state. Never generate
a replacement application key for existing records. Keep `.ids` reservations.

For code rollback, stop the service, preserve a fresh consistent state/key backup,
change WorkingDirectory to the chosen known-good release, reload systemd and test.
If reverting to Windows, copy the latest Oracle state/key first, leave Oracle
stopped, then deliberately clear BOT_DISABLED on Windows. Never use the stale
pre-migration data after Oracle has accepted new writes.
