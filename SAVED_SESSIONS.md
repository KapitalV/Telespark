# Encrypted saved sessions

Registration and password recovery save automatically before final submission. The user does not need to run `/save`, `/dsave` or `/psave` first. OTR recovery keeps its existing flow.

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

Registration: complete fields and CAPTCHA → review → `YES` → automatic save → submit once.

Password recovery: six answers → fresh CAPTCHA → automatic save → submit once.

`/save` keeps the current browser open. Saving incomplete fields creates a **Draft**; the bot updates it to **Ready** automatically before submission. Corrected recovery answers are saved automatically. An expired CAPTCHA requires fresh input.

New records use sequential IDs: `R0001` for registration, `D0001` for form filling and `P0001` for password recovery. Each record has an owner, timestamps, attempt count and status: **Draft**, **Ready**, **Submission attempted**, **Confirmed success** or **Outcome uncertain**. The submission marker is persisted before the final portal method is called. A crash or timeout never triggers replay. Password recovery can record verified success; registration's screenshot-only response stays uncertain. Failed outcome storage does not repeat the request: use `/dsave` or `/psave` to retry saving a result still in memory.

Only the originating Telegram user can retrieve/reuse details and images. Admin dashboards show status metadata, not other users' passwords or applicant fields. Removed users cannot access saved records. Cancellation, timeout and restart clear the browser and memory but retain encrypted copies. Reuse validates saved selections against current portal values and labels and asks again if an option changed. It requires fresh verification and saves automatically. Opening a record never submits to the website.

## Storage and backup

### Saved-user shortcuts across menus

`/saveuser` stores registration, OTR and a chosen password encrypted. `/saveuserNN`
selects that owner's profile using the last two OTR digits. It works from the main
menu or inside an individual module. It never replaces an active Excel batch.

- **Form filling:** choose action, Fresh/Renewal and category. Saved credentials
  fill automatically and the next prompt is the login CAPTCHA. Sending the
  shortcut after choosing these options retains them.
- **Final Print:** choose Fresh/Renewal, then answer the login CAPTCHA. There are
  no repeated saved-registration, OTR or password confirmation prompts.
- **Password recovery:** registration fills automatically; missing verification
  fields are still requested.
- **OTR:** scholarship registration can reuse the OTR. Recovery still asks for
  the registered mobile number; login profiles do not contain it.
- **Saved sessions:** viewing records remains available with the profile selected.

`/menu` keeps the selection; `/cancel`, revocation, 20-minute expiry and restart
clear it. Only the selected record ID/suffix are retained between menu choices.
Passwords are decrypted for the authorized login and hidden in messages/logs.
Wrong-password responses request correction rather than retrying automatically.
Section reviews, final-lock confirmation and fresh CAPTCHA/OTP input remain required.
Use `/back` to correct a login field before submitting its CAPTCHA.

The file store needs no database service. It uses AES-256-GCM with a random nonce per write, authenticates each record against its session ID, and writes ciphertext through a flushed temporary file followed by replacement. Registration records include the chosen password; matching confirmation is reconstructed only for reuse. Recovery records retain the six answers and the verified returned password. Result PNGs are encrypted with the record; CAPTCHA/OTP controls are masked before capture. OTPs, CAPTCHA answers, cookies and arbitrary form fields are excluded.

Defaults:

- Records: `data/saved-sessions/*.enc`, configurable with `SAVED_SESSIONS_DIR`.
- Separate, automatically generated 32-byte key: `data/private/saved-session.key`, configurable with `SAVED_SESSION_KEY_FILE`.

**Back up both records and the original key.** Put both on persistent storage on hosted servers. Losing the key makes records unreadable; startup refuses to replace a missing key when records already exist. Keys and ciphertext are excluded from Git and Docker builds. Restrict filesystem access to the bot account; encryption cannot protect against someone who can read both the key and records. Unix creation modes restrict files to their owner; Windows uses the directory's inherited access permissions.

Saved records have no automatic expiry or deletion. Old sessions cleared before this version cannot be recovered retroactively. Telegram messages remain subject to Telegram storage/copy behavior. `/log` records save/view/reuse actions without saved values or passwords.

## Verification

Tests cover encrypted restart recovery, missing/wrong keys, tampering, owner isolation, admin metadata, interrupted submissions, failed writes, stale saved values, correction and CAPTCHA expiry, result re-delivery, and new-session reuse. Intercepted browser tests cover optional saves, YES confirmation, automatic saving, receipt retrieval and reuse against current options. No live registration or password reset is performed by these tests.

## Short session IDs

Sequences are independent per module and shared across users. Ownership checks still apply to every read and reuse. IDs contain one letter and four digits, from 0001 to 9999; exhaustion stops new saves instead of overwriting records or rolling over. Existing long R-/P-/F- IDs remain readable and are not renamed. CONFIRM remains a compatibility alias; current prompts use YES.

The `.ids/` folder inside saved-session storage reserves numbers atomically. Keep it with your backups so deleted/failed record numbers are never reassigned. A failed save can leave a gap in the sequence. No candidate details or credentials are stored in reservation files.
