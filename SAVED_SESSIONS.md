# Encrypted saved sessions

Registration and password recovery require an encrypted save before a final submission. OTR recovery keeps its existing flow.

| Command | Behavior |
| --- | --- |
| `/save` | Dashboard and Registration / Password recovery buttons. Admin sees all users' status metadata; others see their own records. |
| `/save 2` | Next dashboard page (10 records per page). |
| `/save user ID [page]` | Admin: status metadata for one user. |
| `/dsave` | Save the current registration; without an active form, show its saved record or your registration list. |
| `/psave` | Save recovery details; without an active form, show its saved record or your recovery list. |
| `/dsave SESSION_ID`, `/psave SESSION_ID` | Retrieve your saved details, password and available response image without contacting the portal. |
| `/dsave list [page]`, `/psave list [page]` | Browse your own records while another form is active. |
| `/reuse SESSION_ID` | Load saved fields into a fresh session; creates a new record when saved. |

Registration: complete fields and CAPTCHA → `/save` → `/dsave` → review → `CONFIRM`.

Password recovery: six answers → `/save` → `/psave` → fresh CAPTCHA → submit.

`/save` keeps the current browser open. Saving incomplete fields creates a **Draft**; save again when all fields are complete to mark it **Ready**. Correcting a recovery answer requires another save. An expired CAPTCHA requires fresh input.

Each record has a unique `R-…` or `P-…` ID, owner, timestamps, attempt count and status: **Draft**, **Ready**, **Submission attempted**, **Confirmed success** or **Outcome uncertain**. The submission marker is persisted before the final portal method is called. A crash or timeout never triggers replay. Password recovery can record verified success; registration's screenshot-only response stays uncertain. Failed outcome storage does not repeat the request: use `/dsave` or `/psave` to retry saving a result still in memory.

Only the originating Telegram user can retrieve/reuse details and images. Admin dashboards show status metadata, not other users' passwords or applicant fields. Removed users cannot access saved records. Cancellation, timeout and restart clear the browser and memory but retain encrypted copies. Reuse validates saved selections against current portal values and labels and asks again if an option changed. It requires another save and fresh verification. Opening a record never submits to the website.

## Storage and backup

The file store needs no database service. It uses AES-256-GCM with a random nonce per write, authenticates each record against its session ID, and writes ciphertext through a flushed temporary file followed by replacement. Registration records include the chosen password; matching confirmation is reconstructed only for reuse. Recovery records retain the six answers and the verified returned password. Result PNGs are encrypted with the record; CAPTCHA/OTP controls are masked before capture. OTPs, CAPTCHA answers, cookies and arbitrary form fields are excluded.

Defaults:

- Records: `data/saved-sessions/*.enc`, configurable with `SAVED_SESSIONS_DIR`.
- Separate, automatically generated 32-byte key: `data/private/saved-session.key`, configurable with `SAVED_SESSION_KEY_FILE`.

**Back up both records and the original key.** Put both on persistent storage on hosted servers. Losing the key makes records unreadable; startup refuses to replace a missing key when records already exist. Keys and ciphertext are excluded from Git and Docker builds. Restrict filesystem access to the bot account; encryption cannot protect against someone who can read both the key and records. Unix creation modes restrict files to their owner; Windows uses the directory's inherited access permissions.

Saved records have no automatic expiry or deletion. Old sessions cleared before this version cannot be recovered retroactively. Telegram messages remain subject to Telegram storage/copy behavior. `/log` records save/view/reuse actions without saved values or passwords.

## Verification

Tests cover encrypted restart recovery, missing/wrong keys, tampering, owner isolation, admin metadata, interrupted submissions, failed writes, stale saved values, correction and CAPTCHA expiry, result re-delivery, and new-session reuse. Intercepted browser tests cover registration save → confirmation → receipt → retrieval → reuse against current options. No live registration or password reset is performed by these tests.
