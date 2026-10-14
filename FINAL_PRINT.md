# Form lock & Final Print

Main menu **5. Form lock & Final Print**. Menu item 4 opens the existing saved-session dashboard.

The admin also sees **Excel batch** beside Fresh/Renewal. It processes a candidate workbook for printing only and never calls the lock operation. See [FINAL_BATCH.md](FINAL_BATCH.md) for the template, commands and safeguards.

1. Choose Fresh or Renewal. The bot uses the respective official `LoginStudentPost.aspx` or `LoginStudentPostRenew.aspx` URL.
2. Enter registration number and OTR.
3. Choose **Use default password** or **Other**. The default comes from the local `FINAL_DEFAULT_PASSWORD` environment setting; its value is not displayed in buttons or committed to source. Other passwords are entered for that login only.
4. Enter the current CAPTCHA. `/refresh` replaces it.
5. The bot verifies the dashboard registration and reads the live lock/print controls. Existing institution print availability skips locking.
6. Review the applicant, portal notice and confirmation warning, then reply **YES** to authorize one lock attempt. The observed literal `onclick` confirmation is included in the initial review; the bot accepts OK only when that exact reviewed warning appears. A changed warning invalidates the review. Other JavaScript confirmations are dismissed and shown for a further YES. Unknown forms stop.
7. When the institution print link is available, download its official PDF, or generate an A4 PDF from that authenticated page. Validate readable pages and applicant registration before sending it to the same authorized private chat.
8. If that mapped print page contains a recognized portal server error, print and send it as `Lnnnn-INCOMPLETE-portal-error.pdf`, as requested. Its caption explains that it is not a valid application. Store it encrypted with an incomplete flag and uncertain status; `/result Lnnnn` preserves the warning. Missing applicant details are never manufactured.

The observed **PRINT THIS PAGE** button invokes `window.print()`. The bot uses the browser's print layout to generate PDF bytes directly and sends a downloadable Telegram document, like Check Print. No desktop Save dialog is needed. Once the portal returns a complete valid application, the normal final-PDF path is used automatically.

The portal notice supplied during development says to print after three days. The bot cannot make a disabled link available. Confirmed locking with no print link returns a waiting message; a later fresh login rechecks status. There is no scheduled polling or automatic re-lock.

## Records and controls

`L0001`, `L0002`, etc. identify encrypted lock-attempt and final-PDF records. `/save` lists statuses, `/save L0001` retrieves the owner's record, `/result L0002` retrieves a saved PDF without login. Lock and PDF records are separate. Session passwords, CAPTCHA answers, cookies and portal dialogs are not persisted. The configured default password is stored only in local environment configuration.

One session per private authorized chat; /cancel, timeout, access revocation and shutdown close browsers. Duplicate messages cannot lock twice. A persisted attempted/uncertain record is never automatically replayed. PDF saving/delivery failures retain the in-memory PDF for `/result`; they never repeat locking. Admin logs contain module/action/outcome metadata only.

Configuration:

```dotenv
ENABLE_FINAL_PRINT=false
FINAL_DEFAULT_PASSWORD=
```

Enable locally to conduct a supervised live test. No remote deployment is included.

## Validation limits

The supplied Fresh dashboard establishes `ContentPlaceHolder1_Href_temp_lock`, the ASP.NET postback target, and the `ContentPlaceHolder1_FinalPrint` container. Final print destinations are read from the live enabled anchor, not constructed or clicked by row number. Renewal uses its specified login URL but its checked renewal mode must be explicitly labelled and the dashboard controls must match; additional controls or unfamiliar pages are unsupported.

Live Fresh inspection on 2026-10-13 verified the literal browser confirmation, the dashboard postback, and the locked waiting state after the user accepted OK. The portal removes the lock anchor, displays `Img_temp_lock.fa-check-circle`, and leaves `Span_final_Form` without a print anchor. The bot recognizes this as locked/waiting and does not lock again. A separate applicant had institution print enabled, as described below. Real Renewal login and complete final PDF layout/delivery remain unverified. Synthetic offline tests exercise confirmation changes, duplicate submissions, PDF validation and delivery retry.

The bot takes an OS-owned token-specific local instance lock at startup. A second local copy exits before consuming Telegram updates; the lock releases on shutdown or crash. This prevents competing local conversations. Remote deployments using the same token must still be stopped separately.

Final-print diagnosis on 2026-10-13 observed an enabled Fresh link to `FinalDisclaimer.aspx`, followed by navigation to `FinalPrintInstitute.aspx`. This specific transition is now allowed and the final destination is validated. The live final page returned `System.ArgumentException` for a missing `AboutMotherFather` column and blank applicant fields. The requested update prints this as an explicitly incomplete diagnostic PDF (`print-error-pdf` in metadata logs), without repeating locking. A valid real final application cannot be confirmed until the portal returns a complete document. Offline tests cover the mapped transition, diagnostic print delivery/retrieval, owner isolation, delivery retries, and rejection of unmapped destinations.

Run `OTR_BROWSER_TESTS=true node --test --test-concurrency=1` (set the environment variable using your shell). Browser tests intercept all requests and use an offline context. On this machine use a temporary directory on D: because C: is full.
