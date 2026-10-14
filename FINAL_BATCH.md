# Excel Final Print batch

Admin-only, private-chat printing for up to 100 candidates. This workflow cannot lock an application. Use option 5 individually for that action. The existing Final Print adapter, encrypted L records and PDF checks are reused.

## Use

1. Send `/finaltemplate` for `Final_Print_Batch_Template.xlsx` (also in `assets/`). Fill the single `Candidates` sheet. Keep its headers unchanged. Registration and OTR cells must contain text; paste values without formulas to retain leading zeros. Name is optional. Application Type offers Fresh/Renewal and defaults to Fresh.
2. Send `/finalbatch`, or choose **Excel batch** within option 5. Upload the completed `.xlsx` (maximum 2 MB). Blank rows are ignored. The bot lists valid, invalid and duplicate counts; repeated valid registrations are skipped.
3. Send **YES**, then select **Gpm preset**, **Deepak preset**, or **Other**. Only configured presets appear. The password applies to this batch in memory only.
4. Reply directly to each current CAPTCHA photo. Each candidate receives a fresh isolated browser. `/refresh` replaces the current CAPTCHA. Old-photo replies and duplicate updates cannot advance another candidate.
5. Available final PDFs are saved encrypted and sent in order. Unlocked applications are reported and skipped. Locked applications without print availability are reported and skipped. Recognized portal-error PDFs retain the **INCOMPLETE** name, warning and saved-result flag.
6. Login rejection offers a candidate-specific password correction, `/retry` with a fresh login/CAPTCHA, or `/skip`. It does not classify the registration as invalid. The next candidate uses the original batch password.
7. The completion CSV contains workbook row, registration, status and saved PDF ID. `/result L0001` retrieves an existing PDF only for its authorized owner, without visiting the portal.

## Commands and failure handling

| Command | Behavior |
|---|---|
| `/finaltemplate` | Send the blank Excel template |
| `/finalbatch` | Request an upload; refuse to replace an active batch |
| `/batchstatus` | Show current progress and row outcomes |
| `/skip` | Resolve the current candidate as skipped and prepare the next |
| `/retry` | Retry the failed login/network step, or resend an already retained PDF |
| `/refresh` | Replace the current login CAPTCHA |
| `/cancel`, `/menu` | Clear the queue/passwords and close the active browser |
| `/result Lxxxx` | Retrieve a saved PDF, retaining any INCOMPLETE warning |

PDF delivery failure pauses the batch. `/retry` reuses the same saved PDF without login, printing or locking again. If Telegram accepted a document but its acknowledgement was lost, retry can deliver another copy of that same PDF. A skipped delivery retains its L ID in the report.

Uploads and pending answers are held in memory, never saved to disk or activity logs. Logs record module/action/stage/outcome only. A completed PDF and its application identity are stored using the existing encrypted saved-session system. Cancellation, access revocation, 20-minute inactivity or shutdown clears pending data and closes the browser. On restart there is no automatic batch resume: upload only the remaining rows. Exactly one admin batch is possible; group chats and non-admin uploads are rejected before download.

## Local configuration

Enable through the existing `ENABLE_FINAL_PRINT` setting. Store presets only in local `.env`:

```dotenv
ENABLE_FINAL_PRINT=true
FINAL_DEFAULT_PASSWORD=
FINAL_BATCH_DEEPAK_PASSWORD=
```

Never add passwords to source, template or logs. A blank preset is hidden; **Other** remains available. Runtime parsing uses pinned ExcelJS 4.4.0 in a bounded worker, with ZIP expansion checks, a 10-second parse deadline and a worker heap limit. The uuid override uses the compatible v4 API and removes an advisory in ExcelJS's older dependency.

The template was authored/rendered using the bundled spreadsheet tools. SpreadsheetML tag prefixes were normalized for ExcelJS interoperability without changing cells or formatting. Tests reopen the actual shipped file to check every dropdown, text format and the frozen header.

## Verification and release limits

`node --test test/batch-workbook.test.mjs test/final-batch.test.mjs` covers parsing, template compatibility, limits, formulas, leading zeros, duplicates, authorization, password corrections, CAPTCHA retries, status-only unlocked handling, ordering, cancellation, expiry, delivery failure and owner-only incomplete-result retrieval. The batch portal method allowlist excludes `lock`; tests assert zero lock calls across all outcomes.

Run the full regression suite with `OTR_BROWSER_TESTS=true node --test --test-concurrency=1`. Browser fixtures intercept requests offline. These tests do not prove live Renewal or government portal availability. Unknown portal branches remain unsupported. No remote deployment or live batch processing is part of this change; leave the local bot stopped after synchronization.
