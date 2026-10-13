# OTNew-Poly

Local feature branch: `feature/otnew-poly`. The feature defaults to disabled with
`ENABLE_OTNEW_POLY=false`. Existing modules retain their existing flags and behavior.

## Telegram interface

Main menu option **3. Form filling OTNew-Poly** contains:

1. Fill/continue application
2. Verify income and caste
3. Download check-print PDF

The main form-filling action automatically continues to income/caste verification
after entry is complete. Once the portal confirms both certificates, the bot
automatically opens check print, validates and encrypts the PDF, and sends it to
the same authorized private chat. There is no extra "download" selection at the
end. Already-verified certificates are skipped and lead directly to the PDF.
The standalone PDF action remains available for later retrieval or a new login.
If PDF preparation fails after verification, the bot preserves the confirmed
verification outcome and asks for a fresh PDF-only login; it does not repeat
certificate verification. A failed Telegram delivery can be retried with
`/result` using the retained PDF.

The bot asks for the existing registration number, OTR, password and current
CAPTCHA, then creates a separate authenticated browser session. Credentials from
the development conversation are never embedded in source or fixtures.

Each supported application section asks its mapped fields, displays a review and
the official declaration, requires `YES`, and then requests the CAPTCHA.
`/edit` reopens a field and its subsequent dependent questions. `/search words`
and `/next` work on live dropdown options. `USE DEFAULT` and `USE SAVED` are
explicit choices; saved dropdown values must still be available in the portal.
Account confirmation is always asked again and compared as a string.

Certificate retrieval and verification are separate actions. The retrieved
certificate must contain the requested application and certificate numbers and
issued status. The user then checks identity/income/category and replies `MATCH`
or `MISMATCH`. An unknown branch or mismatch stops verification.

Completed entry is skipped when the dashboard offers the observed application
update link. Certificate completion requires the observed completed dashboard
label/checkmark. These signals still require the fresh-session live acceptance
check described below; they do not imply final locking or scholarship approval.

## Defaults and supported branches

The mapped Fresh Postmatric Polytechnic flow supports the two Diploma Engg
Group 3/4 course options, Computer Science/Electronics branches and High School
qualification. Defaults: regular study, course year 1, direct admission No,
lateral entry No, counselling Yes/JEECUP. Counselling year 2026 is offered as a
default only when the page identifies session 2026-27. High-school total marks
default to 600, its mapped fee field to 634, and annual compulsory fee to 11010.
Percentage is calculated from obtained/total marks to two decimals.

Parents status is selectable from the actual portal options. Only the observed
both-parents-alive branch is mapped: father occupation private/autonomous with
income asked; mother occupation homemaker with income default 0. Other parents
branches, additional editable disability/family-ID fields, changed declarations,
unexpected forms or external identity steps stop for inspection. They are not
silently filled or submitted. Live mapping of optional personal controls remains
a release prerequisite if they are editable on the current portal.

Bank, district, branch, account, repeated account and passbook name are asked
individually. The portal-provided IFSC is validated and shown in review. Names
and financial details have no applicant-specific defaults.

## Saving and documents

Details are stored using the existing AES-256-GCM store and key. OTNew-Poly IDs
use `D0001`, `D0002`, and so on. Existing `F-...` IDs still work. `/save` checkpoints current answers and lists section/status
records; `/save D0001` retrieves the user's record. `/reuse D0001` opens a fresh
session with selectable saved answers. `/result D0001` sends a saved PDF without
logging in or posting a form. Administrators can list status metadata but cannot
retrieve another user's private details or PDF.

Each submission has a durable attempted marker. A confirmed transition, explicit
CAPTCHA rejection or uncertain outcome updates that record. Uncertain attempts
cannot be replayed; a fresh login is required to inspect status.

The adapter follows the observed official check-print link. If that page exposes
an official PDF download, it uses it; otherwise Chromium prints the official HTML
as A4. PDF.js checks parseability, page count, readable text and registration
identity. The encrypted PDF is saved before Telegram `sendDocument`; delivery
retries never repeat portal submissions. Documents use `application/pdf` and
remain copyable/downloadable.

Login passwords, CAPTCHA answers, account confirmation, cookies, page tokens and
certificate table contents are not saved. The supported entered form fields,
certificate numbers and PDF are encrypted. Activity logs use a closed vocabulary
and contain actions/stages/outcomes, not answers or documents. Cancellation,
timeout, revoked access and shutdown close browser sessions.

## Validation and release gate

Run `node --test --test-concurrency=1` for unit tests. Set
`OTR_BROWSER_TESTS=true` to include browser fixtures. New portal fixtures intercept
all network requests and also set the browser offline; they contain synthetic
data only. The optional `POLY_PDF_FIXTURE_DIR` writes a synthetic two-page PDF for
rendering and visual inspection.

Before setting `ENABLE_OTNEW_POLY=true`:

1. Restore a normal official HTTPS browser page after the browser-policy block.
   Do not bypass the blocked embedded error page through another browser surface.
2. Create a fresh login, inspect the completed application's saved academic,
   personal, bank and fee details, and verify the income/caste completion status.
   Do not resubmit these already-completed sections.
3. Inspect the actual check-print layout and any download link. Render every PDF
   page and check identity, completeness, Hindi text and clipping. Update mapping
   only from observed portal controls; keep unknown branches unsupported.
4. With exactly one bot consumer, perform the authorized Telegram PDF-delivery
   test. Confirm the real PDF opens and reaches the applicant's authorized chat.
5. Enable the local module only after these checks pass. No cloud deployment,
   Git push or final application locking is part of this change.

At implementation time the fresh-login check, real PDF and Telegram delivery are
pending. Mocked tests and a synthetic PDF are not evidence of live acceptance.

Validation completed on 2026-10-12: 131 regression tests passed with browser
fixtures enabled and no skips. Both synthetic PDF pages were rendered and
visually inspected. Telegram accepted the 41,886-byte `OTNew-Poly-TEST.pdf` in the
configured admin private chat with MIME type `application/pdf`; this was a
synthetic transport test, not the applicant's real document.

To explicitly repeat only that transport test, use
`node --env-file=.env scripts/check-poly-pdf-delivery.mjs --send-to-admin PATH_TO_SYNTHETIC_PDF`.
The script requires the marked synthetic fixture, sends only to the configured
admin's private chat and does not consume updates or contact the portal.

The automatic form → certificate verification → PDF delivery update also passed
the full suite: 134 tests, zero failures and zero skips. New coverage checks
automatic continuation, already-verified certificates, two-user document
isolation and PDF failures without repeating certificate verification.

## Operational receipt checks

Authorized users can send `/test` without arguments. It returns a structured
`200 OK` acknowledgement and writes metadata to `/log`. This proves the bot
responds; `portalVerified: false` explicitly distinguishes this from a completed
portal transaction. Malformed `/test` arguments return `INVALID_TEST_REQUEST`
and flag the admin, limited to one alert per minute. Submitted values are omitted.

Authenticated webhook requests return JSON acknowledgements; invalid JSON,
invalid message envelopes and oversized bodies return structured 400/413 errors
and alert the admin. Unauthorized requests never reach portal processing.
Duplicate update IDs in the current process are acknowledged and ignored; the
webhook retains the latest 2,000 IDs, and the router also rejects repeated/older
message IDs per chat. Restarting clears the in-memory history and active sessions;
polling startup intentionally discards pending old replies. This is not a durable
exactly-once transaction system. An uncertain portal submission still stops for
status inspection instead of automatic resubmission.

Local live testing may be enabled at the owner's request. This does not mark the
real applicant PDF acceptance checks above as passed. Keep unknown portal branches
unsupported and use Download check-print PDF for a completed application.
