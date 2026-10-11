# OTR verification and manual testing

For the subsequent recovery-only rebuild, see [OTR_RECOVERY.md](OTR_RECOVERY.md).
That requested rebuild was tested again: 60 automated tests passed; the live
portal still returned HTTP 503. The older 54-test record below describes the
initial implementation.

The owner subsequently requested a local merge and explicitly requested no
further tests. The earlier pre-merge manual-test gate is waived for this merge.
The results below were recorded before that instruction. Live verification is
still pending; no deployment or service restart is part of the local merge.

## Development verification — 2026-10-10

- Windows / Node 24 / installed Edge: **54 tests passed**, including the
  original regression suite and intercepted browser contracts. No skipped tests
  in the run with `OTR_BROWSER_TESTS=true`.
- The full synthetic registration conversation passed through declaration,
  category/mobile/CAPTCHA, mobile OTP, Aadhaar fields, another OTP, final details,
  and explicit final confirmation. This is not live e-KYC verification.
- Initial read-only live checks reached the recovery CAPTCHA and registration
  declaration. Later checks and the requested retry received **HTTP 503** from
  both public OTR pages. The bot reports this status and offers `/retry` for a
  failed page load.
- No real OTP was requested, no OTR was created, and no Telegram token was used
  by these tests. Existing bot files, runtime, deployments, and credentials were
  left untouched. Live OTP/e-KYC/result verification remains for the owner's
  later manual bot test.

## Isolation and release status

- Branch: `feature/otr-modules`, based on working commit `005c261`.
- Development used a separate checkout; approved source changes can now be
  copied into the local bot folder with a rollback backup.
- `ENABLE_OTR` defaults to false. No tokens, real applicant fixtures, or results
  belong in Git. No changes to Render, cron-job.org, or webhook configuration are
  needed to review this branch.
- A passing automated suite is not authorization to merge or deploy.
- The owner approved the local merge without more tests. If a protected form is
  unsupported, its adapter still needs completion and later manual verification.

## Automated checks

```powershell
npm ci --ignore-scripts
npm test
$env:OTR_BROWSER_TESTS = 'true'
node --test test/otr-browser.test.mjs
Remove-Item Env:OTR_BROWSER_TESTS
npm run test:otr-portal
```

Browser contracts use Edge on Windows or installed Playwright Chromium on Linux.
All browser-contract requests are intercepted; synthetic OTPs never leave the
test browser. Use `npx playwright install chromium` if Linux lacks the browser.
The separate live portal check only reads public pages and CAPTCHA images. It
does not agree to declarations, solve CAPTCHAs, request OTPs, or create an OTR.
Registration's direct form URL redirects fresh sessions to the declaration;
that redirect does not count as a live verification of the protected form.

## Manual Telegram test — only when the owner starts the test window

1. Record the working bot's folder, command, and revision. Stop its existing
   process. Keep its `.env` untouched. Use one consumer of the token at a time.
2. In this feature checkout, enable OTR only for the test process. On this PC:

   ```powershell
   $env:ENABLE_OTR = 'true'
   $env:BOT_MODE = 'polling'
   node --env-file="D:\electroshorts\scholarship-telegram-bot\.env" bot.mjs
   ```

   If a webhook exists, the bot deliberately refuses polling. Do not remove or
   replace it automatically; resolve the actual existing runtime before testing.

3. In the private owner chat, `/start` -> `1` must still complete the existing
   Fresh/Renewal question flow. `/menu` must close that session.
4. `/start` -> `2` -> `1`: supply the registered mobile, answer the latest
   CAPTCHA, and enter the real SMS OTP. Verify the OTR against the official
   result/SMS. Check `/result` sends it again without requesting another OTP.
5. `/start` -> `2` -> `2`: only test with an applicant who has no existing OTR.
   Review the declaration and type `AGREE`. Answer category, mobile, CAPTCHA,
   OTP, and subsequent recognized portal fields. Review final details and type
   `CONFIRM` only when correct. Do not create a duplicate registration for testing.
6. If an unsupported stage appears, stop. Record only the stage and non-personal
   control labels needed to improve the adapter. Never put Aadhaar, OTPs, mobile
   numbers, or screenshots containing personal data in issues or test fixtures.
7. Test `/cancel`, old image replies, an incorrectly typed CAPTCHA, and the
   OTP resend cooldown without generating repeated unnecessary requests. Use
   synthetic tests for rate limits and duplicate registration errors.
8. Stop the test process with Ctrl+C. Remove the temporary environment overrides:

   ```powershell
   Remove-Item Env:ENABLE_OTR
   Remove-Item Env:BOT_MODE
   ```

   Restart the original bot using its recorded folder and command. Verify it
   responds normally. Any subsequent deployment requires the owner's instruction.

## Architecture and verification boundaries

- `router.mjs`: menus, access checks, sequential per-chat routing, cleanup.
- `otr-core.mjs`: field prompts, validation, confirmation, OTP/CAPTCHA lifetimes,
  duplicate protection, explicit retry handling, and copyable results.
- `otr-portal.mjs` / `otr-schema.mjs`: isolated browser context, live form
  structure, explicit recognized action types, ASP.NET postback waits, and
  conservative result classification.
- `otr-recovery.mjs`: dedicated recovery classification, Hindi OTP controls,
  verified-session result handling, and full/partial postback submission waits.
- The original `core.mjs` and `portal.mjs` password recovery logic is unchanged.
- Later-stage fixture names/fields are synthetic adapter contracts. A fixture
  passing is not evidence that a particular e-KYC or result page matches today.
- The adapter does not automate external DigiLocker/Aadhaar permissions, face
  verification, unknown radio/file/password fields, or unrecognized submit
  buttons. These produce a stopped experimental session, not a success message.
- A timeout after a submission or an unchanged form without a recognized error
  is uncertain. Check SMS/portal before starting another session; the bot never
  automatically repeats that operation.
