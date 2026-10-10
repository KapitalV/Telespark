# OTR recovery rebuild

The bot uses `OtrRecoveryPortal` in `otr-recovery.mjs` for **OTR -> Recover OTR**.
Registration continues to use its separate existing adapter.

## Behavior

1. Open the official recovery page and ask for the registered mobile number.
2. Show the website CAPTCHA and accept the user's answer. CAPTCHA refresh or
   rejection retains the mobile number in this session instead of asking again.
3. Request an OTP once and wait for the website's OTP form. Recognize both Hindi
   and English verification controls, including a masked OTP input.
4. Submit the user-entered OTP once and return a clearly labelled OTR result.
   Accept a result only after this same browser session submitted verification.
5. `/result` re-delivers the result without another website request. Cancellation,
   expiry, completion, and uncertain outcomes clear the saved mobile number.

Recovery submissions support full page reloads and in-place form updates. OTP
sent notices are distinguished from invalid/expired OTP errors. An unavailable
resend control reports that no new OTP was requested. Duplicate replies and
uncertain outcomes never trigger automatic repeated submission.

## Verification, 2026-10-10

- **60 automated tests passed, none skipped** with `OTR_BROWSER_TESTS=true`.
- These include the Telegram menu/router and conversation handlers connected to
  a real Edge browser with intercepted website responses. The recovery scenario
  exercises mobile -> CAPTCHA refresh -> Hindi masked OTP -> inline/read-only
  OTR result, plus `/result` without another POST.
- Existing password recovery and registration contract tests also passed.
- These simulations do **not** prove real Telegram delivery, SMS delivery, or
  successful recovery from the live government database.
- Both live public-page checks returned **HTTP 503 Service Unavailable**, including
  the final retry. No real mobile number, CAPTCHA answer, or OTP was submitted.

## Remaining live acceptance

After the official website is available, use the updated bot in the private
owner chat: `/start` -> `2. OTR` -> `1. Recover OTR`. Enter your registered mobile,
answer the current CAPTCHA, and provide the SMS OTP. Compare the returned OTR
with the official result/SMS. The running process must be restarted to load
updated source files; changing files alone does not replace its loaded modules.

Do not call live recovery verified until this acceptance step succeeds. No
production restart, webhook change, GitHub push, or deployment is part of this
local merge.
