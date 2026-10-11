# Telespark — UP Scholarship Telegram recovery bot

This personal bot asks six questions in a private Telegram chat, fills the official postmatric recovery website, sends the CAPTCHA image, and submits when you reply with its text. On success it returns the latest password and the recovery slip. It uses Node.js, Playwright, and the Telegram Bot API. No AI subscription or public server is needed to run it on your PC.

To use it while your PC is off, follow [Deploy on Render](DEPLOY_RENDER.md). The included Dockerfile uses Chromium on Linux and reads secrets from the hosting environment. Free web-service hosting uses Telegram webhooks; a paid worker uses polling.

## 1. Create your Telegram bot

Open the official [@BotFather](https://t.me/BotFather) account in Telegram. Send `/newbot`, choose a name, and choose a unique username ending in `bot`. Copy the token BotFather supplies. Put it only in the local `.env` file below.

Official instructions: https://core.telegram.org/bots/features#creating-a-new-bot

## 2. Install the program

Open PowerShell and run:

```powershell
git clone https://github.com/KapitalV/Telespark.git
cd Telespark
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

Node.js 22 or later and Git must be installed. Download Node.js from https://nodejs.org/en/download if needed. If you download the repository as a ZIP instead of cloning, extract it and open PowerShell in the extracted folder before running `setup.ps1`.

Setup installs the pinned dependencies, checks for Microsoft Edge, and creates `.env` from `.env.example` if it does not already exist. The bot uses your installed Edge in a separate automation session, avoiding a large browser download. It does not change Windows execution policy persistently.

## 3. Add your token

Open `.env` in a text editor. Set the token, leaving the owner ID empty for the first run:

```dotenv
TELEGRAM_BOT_TOKEN=YOUR_BOTFATHER_TOKEN
TELEGRAM_ALLOWED_USER_ID=
HEADLESS=true
BROWSER_CHANNEL=msedge
```

The placeholders are examples; never paste them literally as your token. Set `HEADLESS=false` if you want to watch the browser. If using an installed Google Chrome instead, set `BROWSER_CHANNEL=chrome`. The default on Windows is Edge even if this line is omitted. On another platform, set `BROWSER_CHANNEL=chromium` and run `npm.cmd run install-browser` (use `npm` outside Windows).

Keep `.env` local. Git ignores it and other `.env.*` files, except the empty `.env.example` template. If a real token has previously been committed, revoke it in BotFather and use a replacement: removing the file from the latest commit does not remove the token from Git history.

## 4. Get your Telegram user ID

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

Open your new bot's private chat in Telegram. Send `/id`. It replies with your numeric user ID. In setup mode the bot only provides setup information; it cannot recover a password.

Press Ctrl+C in PowerShell. Put that numeric ID into `.env`:

```dotenv
TELEGRAM_ALLOWED_USER_ID=YOUR_NUMERIC_ID
```

Start the bot again with the same command. That configured account is the admin. Only the admin and users the admin explicitly adds can use the bot. Group chats are ignored.

### Admin-managed access

Ask another user to open the bot privately and send `/id`. As the configured admin, send `/adduser 123456789` with their numeric ID. They can then send `/start` and use all enabled modules. Use `/users` to list allowed IDs and `/removeuser 123456789` to revoke access and clear their active session. `/admin` shows these commands. Added users cannot manage access or view the allowed-user list. Each chat has separate answers, browser sessions and results.

Access changes survive restarts in `data/authorized-users.json`; this file contains user IDs only and is excluded from Git and Docker build context. Optionally set `ACCESS_STORE_PATH` to another writable path. On a hosted service, put this file on a persistent disk to retain grants across redeployments. Keep `TELEGRAM_ALLOWED_USER_ID` set to your own admin ID; `/adduser` does not require editing `.env` or restarting.

## 5. Recover your password

Send `/start` to your bot. It asks, in order:

1. Fresh or Renewal
2. Registration number for the required session
3. Renewal: date of birth in DD/MM/YYYY. Fresh: registered 10-digit mobile number.
4. Class 10 board (UP BOARD and CBSE BOARD buttons; `/boards` lists other supported recovery boards)
5. Class 10 passing year as entered in your original application
6. Class 10 roll number, preserving leading zeros

The bot fills the official website and sends its CAPTCHA image. Reply with the exact characters, preserving letter case. That reply submits the recovery request. There is no additional confirmation prompt in this user-operated program. CAPTCHA recognition is done by you; automatic CAPTCHA solving is not included.

After success, the bot sends your latest password and a PNG recovery slip. If the official page is readable but its outcome is unrecognized, the bot sends a screenshot labelled as unconfirmed, so you can read the website's response. A result labelled with a different registration number is not delivered. Repeated recovery may generate a different password. Use `/result` to resend a saved result or response screenshot without submitting again. New text and images allow copying, saving, downloading and forwarding; previously protected messages keep their existing Telegram restrictions.

## Commands

| Command | Action |
| --- | --- |
| `/start`, `/menu` | Open the service menu |
| `/id` | Show your Telegram user ID for setup |
| `/boards` | List supported board names |
| `/refresh` | Refill the form and show a new CAPTCHA |
| `/retry` | Retry a failed form load using the six saved answers |
| `/result` | Resend the completed result without resetting the password |
| `/cancel` | Close the browser session and clear the current details |
| `/help` | Show commands |
| `/admin` | Show admin-only access commands |
| `/adduser ID` | Admin: grant a Telegram user access |
| `/removeuser ID` | Admin: revoke access and clear that user's session |
| `/users` | Admin: list allowed user IDs |

## Running and handling errors

For local polling mode, keep this PowerShell process and your PC running with internet access while using the bot. Only one instance should run for a token. Polling needs no incoming ports or public URL. A Render Free Web Service uses webhook mode instead; see the deployment guide. Do not run local polling and the cloud webhook for the same token at the same time.

An invalid CAPTCHA produces a new image while retaining the six details. A recognized mismatch requests only the affected field, such as Class 10 passing year. The response reader handles page navigation, in-place responses and validation alerts. After a navigation deadline it still checks the currently rendered official page. Unknown results stop further submission attempts because the password might already have changed. Check the response screenshot or official site before intentionally starting another recovery. Response diagnostics contain only a result category, an allowlisted page category, HTTP status and whether the click reported an error; they never include answers or passwords.

CAPTCHA replies older than five minutes are not submitted. Idle sessions and completed results are removed from memory after twenty minutes. Restarting clears memory and skips old queued messages to avoid replaying CAPTCHA replies. Applicant details, passwords, and slips are not written to program logs or local storage; they do travel through Telegram and remain subject to Telegram's chat storage. The bot token remains in the local environment configuration; the authorized-user file stores access IDs only. Result messages can be copied or saved.

The bot supports authorized postmatric recovery and the fresh scholarship registration form described below. The website can change its fields, sessions, or verification flow. The bot does not decide scholarship eligibility.

## Validation

After the sixth answer, the bot acknowledges receipt before opening the website. Form preparation has a 75-second deadline. If loading or CAPTCHA delivery fails, `/retry` reuses the answers for up to 20 minutes without submitting a recovery. Failure messages and logs contain only the failed stage and a safe error category, never Playwright's raw messages or filled values.

For deployment diagnosis, temporarily set `PORTAL_STARTUP_CHECK=true`. Startup then fills the six fields with synthetic values and captures the CAPTCHA, logs `portal-probe`, and closes the browser. This check never submits a CAPTCHA or changes a password. Remove the flag after diagnosis to avoid extra startup browser work.

```powershell
npm.cmd test
```

Use `npm.cmd run test:portal` for a live check of both Fresh and Renewal through all six questions to CAPTCHA capture. It uses synthetic data and a local Telegram adapter, never sends chat messages, and never submits recovery. Browser installation is required. A live Telegram/password reset test still needs the owner's real answers and CAPTCHA reply.

The automated tests exercise input validation, admin-only access changes, persistent grants, isolated user sessions, revocation, the six-question flow, corrections, CAPTCHA expiry, duplicate replies, unknown outcomes, and result delivery failures using fake portal/Telegram adapters. They do not submit live recovery requests.

The live website field IDs and success/error text were observed during development. End-to-end Telegram operation requires your token and owner ID and has not been verified until those are configured. The Windows setup uses the installed Microsoft Edge to avoid a bundled browser download.

API documentation: https://core.telegram.org/bots/api#getupdates

Browser automation documentation: https://playwright.dev/docs/library

# OTR recovery and scholarship registration

OTR recovery now has a dedicated adapter; see [OTR_RECOVERY.md](OTR_RECOVERY.md)
for its rebuilt flow. A live recovered OTR screenshot was verified in the
owner's Telegram chat on 2026-10-10.

`/start` now offers **1. Password recovery** and **2. OTR**. Password recovery
retains its existing six-question flow. OTR is off unless `ENABLE_OTR=true`.
Its submenu offers **Recover OTR**, **Scholarship registration using OTR**, and **Back**.

The OTR handler asks for fields from the current official form, shows CAPTCHA
images for the user to answer, accepts SMS OTPs, and preserves the browser
session between steps. Scholarship registration starts from `RegistrationNew.aspx`,
uses an existing OTR, asks the fields in the supplied Fresh Postmatric form,
and requires a final review and `CONFIRM` before submission. It returns the
official response screenshot. See [SCHOLARSHIP_REGISTRATION.md](SCHOLARSHIP_REGISTRATION.md)
for supported courses, searchable institution lists, and verification limits.
`/menu` and `/cancel` clear the current session. `/retry` retries a failed page
load or re-delivers the current prompt; `/refresh` refreshes a CAPTCHA;
`/resend` uses an enabled portal resend control after a minimum 60-second local
cooldown; `/result` re-delivers a verified result without a new submission.

**Registration verification:** the department routes and OTR-unlocked form were
inspected live; the final registration response is covered by intercepted browser
tests and awaits a real applicant submission. No live registration was created
during development. The older create-new-OTR adapter remains separate from the
second menu action. Unknown fields or external verification stop the session.

The bot allows only the configured admin and explicitly authorized users in private chats. It stores OTR session values
in memory, clears OTP inputs after each attempted submission, closes idle
sessions after 20 minutes, and does not log submitted values. Telegram messages
themselves still exist in the chat; session cleanup does not delete chat history.

See [OTR_TESTING.md](OTR_TESTING.md) for checks, the later manual test, and
rollback. Local merge approval does not itself authorize a deployment.
