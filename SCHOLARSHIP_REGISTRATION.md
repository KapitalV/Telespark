# Scholarship registration using an existing OTR

Select `/start` → **2. OTR** → **2. Scholarship registration using OTR**.
This opens the official `https://scholarship.up.gov.in/RegistrationNew.aspx`
in a new isolated browser session. It creates a fresh scholarship application,
not a new OTR. OTR recovery and password recovery keep their existing flows.

## Supported form

Fresh **Postmatric Other Than Intermediate**, studying in Uttar Pradesh
(excluding classes 11–12), matching the supplied screenshot:

- SC / ST / General, OBC, or Minority department, chosen by the applicant.
- Existing OTR lookup.
- District is automatically set to **Jalaun**, using its value from the live portal options, followed by the institution list for Jalaun.
- Category → religion (live dependent options).
- High-school passing year and **UP BOARD** / **CBSE BOARD** reply buttons. Typed `CBSC` is accepted as an alias for CBSE.
- Optional roll-number letter prefix (`NONE` if absent), then numeric roll number.
- Password and matching confirmation, followed by the current CAPTCHA image.
- Review → `YES` → automatic encrypted save → a single submission → official response screenshot. `/dsave` is optional and works without opening `/save`.

The bot does not choose eligibility, caste, religion, or institution for the applicant.
Prematric, classes 11–12, other-state applications and renewal forms are not
exposed by this module. Create-new-OTR code remains separate and is not the
second menu action now.

## Using the prompts

Choose a displayed option number or exact name. Large lists show 15 entries
per message; `/search words` filters them, `/search` clears the filter, and
`/next` pages through matches. Numbers always refer to the original list;
typed years match their exact label first. Institutions with the same name
remain separate numbered choices. All number strings preserve leading zeros.
The district cannot be changed in this flow. If the portal does not offer or retain Jalaun, the bot stops before final registration. Only UP BOARD and CBSE are offered for this registration module; password recovery retains its other supported boards.

`/refresh` replaces the CAPTCHA without discarding already accepted fields.
`/retry` repeats a prompt after message delivery failure; `/cancel` or `/menu`
closes the browser and clears the session. Idle sessions expire after 20 minutes.
`/result` re-sends a captured response without another website submission.

Passwords require 6–12 allowed characters, uppercase and lowercase letters,
a digit, and at least one of `@ # $ &` (checked against the official page's
client validation). Passwords are excluded from reviews and logs; password input
boxes are masked in response screenshots.
Applicant values and screenshots are kept only in process/browser memory and
cleared on cancellation or expiry unless saved through `/save` and `/dsave`.
The encrypted saved record, including the chosen password and result image,
persists through restart and can be retrieved by its owner with `/dsave SESSION_ID`.
See [SAVED_SESSIONS.md](SAVED_SESSIONS.md) for reuse, status and key backup.
Telegram itself retains chat messages;
the bot does not promise to erase Telegram history.
New messages and response images can be copied, downloaded and forwarded. Earlier protected messages retain their original restrictions.

## Verification and boundaries

On 2026-10-10, inspected the live selection page, all three supported department
routes, and the OTR-unlocked OBC form. Confirmed district/institution and
category/religion postbacks, readonly identity, roll prefix length, password
rules, CAPTCHA length/image/refresh and the final button. No live registration
was created during development.

Browser contract tests use these observed IDs in synthetic HTML. Every network
request is intercepted. They cover menus, lookup, dependency postbacks, search,
validation, confirmation, CAPTCHA refresh, one final POST, result re-delivery,
unknown fields and uncertain responses. Run `OTR_BROWSER_TESTS=true npm test`
(PowerShell: `$env:OTR_BROWSER_TESTS='true'; npm test`).

The final receipt layout has not been manually verified. After the final
submission the bot sends the official response screenshot without claiming
success from an unverified layout, accepting another declaration, or submitting
an unknown continuation form. Read the screenshot for completion or validation
errors. If the response is lost, no automatic retry occurs: check the official
portal before starting again to avoid duplicate registration.

The existing `ENABLE_OTR=true` flag enables both menu services; it remains
false by default in the sample environment. Local development does not deploy
to Render, GitHub, or a remote server.
