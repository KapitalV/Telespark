# Form lock & Final Print

Main menu **5. Form lock & Final Print**. Menu item 4 opens the existing saved-session dashboard.

1. Choose Fresh or Renewal. The bot uses the respective official `LoginStudentPost.aspx` or `LoginStudentPostRenew.aspx` URL.
2. Enter registration number and OTR.
3. Choose **Use default password** or **Other**. The default comes from the local `FINAL_DEFAULT_PASSWORD` environment setting; its value is not displayed in buttons or committed to source. Other passwords are entered for that login only.
4. Enter the current CAPTCHA. `/refresh` replaces it.
5. The bot verifies the dashboard registration and reads the live lock/print controls. Existing institution print availability skips locking.
6. Review the applicant and portal notice, then reply **YES** to authorize one lock attempt. A JavaScript confirmation is first dismissed and shown for a further YES; it is accepted only if the exact reviewed text reappears. Unknown forms stop.
7. When the institution print link is available, download its official PDF, or generate an A4 PDF from that authenticated page. Validate readable pages and applicant registration before sending it to the same authorized private chat.

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

Browser inspection could not run because the computer tool reported a request-header policy load failure. Public login-page fetches also timed out. The actual Renewal login, post-lock declaration/transition, waiting-state markup, and real final print layout remain unverified. No live candidate was locked during development. Synthetic offline tests exercise the supported contracts and are not evidence of live portal acceptance.

Run `OTR_BROWSER_TESTS=true node --test --test-concurrency=1` (set the environment variable using your shell). Browser tests intercept all requests and use an offline context. On this machine use a temporary directory on D: because C: is full.
