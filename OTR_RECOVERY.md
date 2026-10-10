# OTR recovery rebuild

The bot uses `OtrRecoveryPortal` in `otr-recovery.mjs` for **OTR -> Recover OTR**.
Registration continues to use its separate existing adapter.

## Behavior

1. Open the official recovery page and ask for the registered mobile number.
2. Show the website CAPTCHA and accept the user's answer. CAPTCHA refresh or
   rejection retains the mobile number in this session instead of asking again.
3. Request an OTP once and wait for the website's OTP form. Recognize both Hindi
   and English verification controls, including a masked OTP input.
4. Collect the OTP and the second CAPTCHA shown by the portal, then submit once
   and return a clearly labelled OTR result.
   Accept a result only after this same browser session submitted verification.
5. `/result` re-delivers the result without another website request. Cancellation,
   expiry, completion, and uncertain outcomes clear the saved mobile number.

Recovery submissions support full page reloads and in-place form updates. OTP
sent notices are distinguished from invalid/expired OTP errors. An unavailable
resend control reports that no new OTP was requested. Duplicate replies and
uncertain outcomes never trigger automatic repeated submission.

## Result-page fix, 2026-10-10

The user's live Telegram attempt reached OTP verification and a second CAPTCHA.
Its response stayed on `/ForgetOTR.aspx`, with no editable fields or buttons.
The page displayed `ContentPlaceHolder1_finalotr_div`, an H3 "Your OTR is"
heading, and an H1 identifier. The previous reader only recognized other output
labels/layouts, missed this final panel, and returned `OTR-FIELDS`.

The reader now recognizes the observed final panel. The panel and heading must
be visible and correctly labelled, its identifier must match the expected
character pattern, and the existing verification/session/error checks still
apply. Unrelated headings, hidden panels, conflicting numbers, remaining input
fields, and results before OTP verification do not count as success.

The regression fixture uses this observed DOM layout with invented values. It
failed with `unsupported` before the change, then passed after it. It exercises
the Telegram router, mobile/CAPTCHA, OTP/second CAPTCHA, result delivery, and
`/result` without a third POST. It is not a replay of private applicant data.

Verification: `OTR_BROWSER_TESTS=true npm test` passed all 64 tests, none skipped,
including the existing password recovery, registration, and webhook tests.

Diagnostics retain control IDs, operational keywords, and digit-group lengths;
they exclude raw page text, actual numbers, answers, cookies, and URL queries.
Recognized results emit only `otr-result-recognized` and the module name.

## Remaining live acceptance

The updated Windows bot must complete one more user-driven attempt through
`/start` -> `2. OTR` -> `1. Recover OTR` to confirm delivery of the live result.
The observed failure is reproduced and fixed in the browser regression test;
successful delivery by the updated live bot must be confirmed separately.
Only one process should consume updates for this Telegram token. A polling
409 diagnostic means another consumer is running locally or on another host.
