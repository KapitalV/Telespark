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

Each action first asks **Fresh** or **Renewal** using Telegram buttons.
Fresh opens `LoginStudentPost.aspx`;
Renewal opens `LoginStudentPostRenew.aspx`. The selected type is saved with the
session and is offered for reference. A `/saveuserNN` shortcut inside an active
login retains the type and action already chosen for that flow. From the main
menu it asks the missing choices, then fills registration, OTR and password
automatically and sends the login CAPTCHA. Ordinary `/reuse` retains its manual
saved-field choices.
Next, choose **1. SC / ST / General** (the existing workflow) or **2. OBC**.
This selects a bot mapping, not a change to the registered category. The choice
is encrypted with the saved session and is asked again during reuse. Switching
routes clears reusable form answers while keeping the saved login identity.
OBC uses `poly-obc-schema.mjs`, an independent starting copy of the existing
sections, and `poly-obc-portal.mjs`, which reuses the checked portal engine.
Live OBC academic inspection identified questions 15–18. The bot now asks both
admission dates in DD/MM/YYYY format, validates real calendar dates, asks the
15-character student enrolment number (E plus 14 digits), and offers the live
day-scholar/residential radio choices. Course year 1/3 is the first-year default
when available; only that year/duration requires dates 15 and 16 to match.
Question 16 still appears and offers date 15 through USE DEFAULT. Other years
can have different dates. These answers are included in encrypted saving/reuse.
The OBC portal's untouched Intermediate fee default of zero and selected year
placeholder do not count as entered qualification data; other populated unused
row fields still stop for review. Further OBC sections and live end-to-end
submission remain unverified until a supervised applicant test.
Unmapped fields pause with an OBC explanation requesting field labels and choices;
they are never guessed or submitted. Mapping changes belong in the OBC schema.
When additional editable fields are found, the OBC reply includes `OBC-FIELDS`,
the section and up to 15 field identifiers/types. The diagnostic excludes field
values, labels and dropdown contents; it is not added to activity logs or saved
applicant records. Copy that diagnostic for mapping. The browser still closes
after an unsupported result, so no unknown form can be submitted by retrying it.
The bot then asks for the existing registration number, OTR, password and current
CAPTCHA, and creates a separate authenticated browser session. Credentials from
the development conversation are never embedded in source or fixtures.

In the OBC route, configured fixed defaults fill automatically when their actual
portal option is available, including field 10, JEECUP. Defaults are still shown
in review, and `/edit` asks the selected field explicitly so it can be changed.
Course, branch, applicant details and admission dates remain questions. Question
16's date suggestion still requires USE DEFAULT or a typed answer. If a fixed
default is unavailable or the portal discards it, the bot asks the field instead
of repeatedly applying it. SC/ST/General keeps its existing manual default choices.
When the official page already selects an approved dropdown/radio answer, the
adapter records that existing choice without dispatching another change event.
Reselecting the same dropdown option can trigger an ASP.NET postback; avoiding
that event prevents the next automatic default from racing a page reload.
Changed choices still wait for their observed postback before reading onward.

Each supported application section collects its mapped fields, displays a review and
the official declaration, requires `YES`, and then requests the CAPTCHA.
`/edit` reopens a field and its subsequent dependent questions. `/search words`
and `/next` work on live dropdown options. `USE DEFAULT` and `USE SAVED` are
explicit choices for prompted fields; saved dropdown values must still be available in the portal.
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

Renewal login routing and compatible fields are covered by isolated browser
fixtures. Protected Renewal pages have not been verified live. Only mapped
fields on allowed official pages are supported; additional or changed Renewal
fields stop for inspection. The bot never falls back to Fresh automatically.

The mapped Fresh Postmatric Polytechnic flow supports the two Diploma Engg
Group 3/4 course options, Computer Science/Electronics branches and High School
qualification. Defaults: regular study, course year 1, direct admission No,
lateral entry No, counselling Yes/JEECUP. Counselling year 2026 is offered as a
default only when the page identifies session 2026-27. The workflow asks for
one High School row, with total marks defaulting to 600 and its mapped fee field
to 634. The portal also renders an Intermediate row; the bot leaves that row
blank and untouched. If it contains prefilled data or a new portal version
changes it, the bot stops for review. High School percentage is calculated from
obtained/total marks to two decimals. Annual compulsory fee defaults to 11010.

OBC keeps separate course/branch filters. Field 2,
`ContentPlaceHolder1_ddl_CourseName`, suggests the unique live option matching
**Diploma In Engg. 3 Yrs (Group 4)**, including equivalent Engineering/Engg label
spellings. Field 3, `ContentPlaceHolder1_ddl_CurrentCourse_Branch`, offers every
non-placeholder branch returned by that course's authenticated portal dropdown,
using its original label and value. Coded or differently formatted branch labels
therefore remain selectable. The observed **Diploma in Electrical** label and
canonical **Electrical Engineering/Engg** labels are recognized for a suggestion
only when there is one unambiguous match. Course and branch remain explicit
user choices, shown in review; option values are read from the page, never
hardcoded. Missing or ambiguous preferred options are not guessed. An empty
dropdown or an unknown editable control still stops the flow.

The 20 October Telegram reproduction confirmed that Group 4 was selected before
the old branch-name allowlist rejected all available branch options. That filter
has been removed for the mapped OBC branch dropdown only. Follow-up authenticated
Chrome inspection established the actual labels: field 2 offers **Diploma Engg
(Group 3)** and **Diploma Engg. 3 yrs Group 4**; field 3 offers **Diploma in
Electrical**. The Course control's inline `onchange` invokes ASP.NET
`__doPostBack` with `ctl00$ContentPlaceHolder1$ddl_CourseName`. Its ID and the
Branch ID match the mapping above. Numeric option values were not captured by
the desktop inspector; the bot reads them from each current dropdown. Browser
fixtures use these observed labels/handler with synthetic values. Other formatted
labels in the tests remain synthetic examples, not live observations.

The OBC adapter waits for the course's observed ASP.NET postback response (full
document or UpdatePanel AJAX), then checks branch option mutations, enabled state
and PageRequestManager completion before prompting. A client AJAX handler without
an inline postback is also covered by the branch mutation/readiness check. A
preselected course does not trigger another change event. Accepting a course
invalidates old branch and later dependent answers, even if option values match.
Timeouts, failed responses, stale tokens and unknown controls stop without a
section submission or automatic repeat. The SC/ST/General schema/adapter remain
unchanged. These cases are covered by `test/poly-obc-cascade.test.mjs` with
intercepted requests and synthetic values. Live inspection establishes labels,
IDs and the Course postback handler; automated continuation through these fields
and a complete section submission still need an authorized applicant test.

Validation on 20 October 2026: all 49 focused OBC/schema/Poly conversation tests
passed with browser fixtures enabled after adding the observed Electrical label.
The earlier full suite encountered a canceled native PDF download in the existing
check-print browser test (and its parent test failed); the OBC checks passed.
The shared PDF implementation was left unchanged while configuring fields 2/3.

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

Passwords entered only for a login, CAPTCHA answers, account confirmation,
cookies, page tokens and certificate table contents are not saved. `/saveuser`
explicitly saves an encrypted password for automatic saved-user login; it is
never shown in the saved-details view. The supported entered form fields,
certificate numbers and PDF are encrypted. Activity logs use a closed vocabulary
and contain actions/stages/outcomes, not answers or documents. Cancellation,
timeout, revoked access and shutdown close browser sessions.

## Validation and release gate

### Optional OBC personal fields

The user explicitly requested leaving `ContentPlaceHolder1_ddl_Handitype`
(disability type) unselected and `ContentPlaceHolder1_txtfamilyid` (family ID)
blank. On the OBC personal page only, these exact controls are allowed through
the unknown-field check when they have their expected types, are not marked
required, and contain no answer. Dropdown placeholders are recognized from
their live labels, not by treating a particular numeric value as a disability.

The bot does not change these controls. Their omission appears in the review,
and their live values remain part of its approval token. Populated controls,
new dependent inputs, and other unexpected fields still stop. SC/ST/General
behavior is unchanged. On 20 October 2026, all 64 focused tests passed with
intercepted Edge fixtures, including a synthetic submission retaining the
unselected dropdown and blank family ID. Live portal acceptance remains to be
verified in the user's next session.

### School names and OBC declaration text

High-school name is a text name, not a numeric school code. It accepts spaced
initials and words such as `Y Y B INTER COLLEGE USRA BAZAR DEORIA`; pasted line
breaks/repeated spaces become single spaces. The live input's maximum length
still applies, and names are not silently truncated.

The OBC snapshot reads declaration text from the mapped visible enabled checkbox's
label, explicit ARIA reference, or a small adjacent text/container relationship.
It does not use a whole-page search or substitute a hardcoded declaration.
Missing, hidden or ambiguous text stops the review. The extracted wording remains
in the review token, so changed wording prevents submission under an older review.
The SC/ST/General declaration reader is unchanged.

On 20 October 2026, 66 focused tests passed with intercepted Edge fixtures enabled,
including full-name retention, adjacent declaration markup, changed declarations
and negative cases. These fixtures cover plausible rendering structures; the
reported live OBC declaration markup still requires a fresh authenticated check.

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

Validation on 2026-10-20: `OTR_BROWSER_TESTS=true` and
`node --test --test-concurrency=1` passed 237 tests with no failures or skips.
The new OBC fixtures inspect course/branch select IDs, opaque option values,
delayed `__doPostBack`, UpdatePanel-style AJAX, client AJAX, unchanged option
lists and preselected courses. They verify Electrical Engineering prompting,
review, course reset/edit invalidation, stale token/value rejection, timeout and
HTTP failure stops without final section submission. The shared general schema
and adapter were unchanged. No current authenticated live course/branch option
values were observed in this run; an authorized applicant test remains pending.
