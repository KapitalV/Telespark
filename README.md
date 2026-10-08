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

Start the bot again with the same command. Only that configured account can perform recovery. Group chats are ignored.

## 5. Recover your password

Send `/start` to your bot. It asks, in order:

1. Fresh or Renewal
2. Registration number for the required session
3. Date of birth in DD/MM/YYYY
4. Class 10 board (UP BOARD, CBSE, ICSE, or `/boards` for the full list)
5. Class 10 passing year as entered in your original application
6. Class 10 roll number, preserving leading zeros

The bot fills the official website and sends its CAPTCHA image. Reply with the exact characters, preserving letter case. That reply submits the recovery request. There is no additional confirmation prompt in this user-operated program. CAPTCHA recognition is done by you; automatic CAPTCHA solving is not included.

After success, the bot sends your latest password and a PNG recovery slip. Repeated recovery may generate a different password. Use `/result` to resend an already completed result without submitting again.

## Commands

| Command | Action |
| --- | --- |
| `/start` | Start a new recovery and ask the six questions |
| `/id` | Show your Telegram user ID for setup |
| `/boards` | List supported board names |
| `/refresh` | Refill the form and show a new CAPTCHA |
| `/result` | Resend the completed result without resetting the password |
| `/cancel` | Close the browser session and clear the current details |
| `/help` | Show commands |

## Running and handling errors

For local polling mode, keep this PowerShell process and your PC running with internet access while using the bot. Only one instance should run for a token. Polling needs no incoming ports or public URL. A Render Free Web Service uses webhook mode instead; see the deployment guide. Do not run local polling and the cloud webhook for the same token at the same time.

An invalid CAPTCHA produces a new image while retaining the six details. A recognized mismatch requests only the affected field, such as Class 10 passing year. Unknown results and navigation timeouts stop submission attempts because the password might already have changed. Check the official site before intentionally starting another recovery.

CAPTCHA replies older than five minutes are not submitted. Idle sessions and completed results are removed from memory after twenty minutes. Restarting clears memory and skips old queued messages to avoid replaying CAPTCHA replies. Tokens, applicant details, passwords, and slips are not written to program logs or local storage; they do travel through Telegram and remain subject to Telegram's chat storage. Protected result messages reduce forwarding and saving but are not end-to-end encryption.

The bot is for your authorized account recovery. The website can change its fields, sessions, or verification flow; update `portal.mjs` if its layout changes. This version handles postmatric recovery; it does not decide scholarship eligibility or submit scholarship applications.

## Validation

```powershell
npm.cmd test
```

The automated tests exercise input validation, owner-only access, the six-question flow, corrections, CAPTCHA expiry, duplicate replies, unknown outcomes, and result delivery failures using fake portal/Telegram adapters. They do not submit live recovery requests.

The live website field IDs and success/error text were observed during development. End-to-end Telegram operation requires your token and owner ID and has not been verified until those are configured. The Windows setup uses the installed Microsoft Edge to avoid a bundled browser download.

API documentation: https://core.telegram.org/bots/api#getupdates

Browser automation documentation: https://playwright.dev/docs/library
