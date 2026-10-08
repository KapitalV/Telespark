# Run Telespark continuously on Render

Use a Docker Background Worker with one instance. The Dockerfile contains Chromium and its Linux dependencies. The Windows Edge installation is not needed on Render. This program uses outbound Telegram polling and does not need a public HTTP endpoint or webhook.

## Before deployment

1. In Telegram's official @BotFather account, revoke the bot token that was previously committed to this repository. Use the replacement token only in Render's environment settings or a private local `.env` file. Removing `.env` from the latest commit did not remove earlier Git history.
2. Have your numeric Telegram user ID ready. If you do not know it, leave `TELEGRAM_ALLOWED_USER_ID` unset for the initial deployment and send `/id` to the running bot. Recovery is disabled until an owner ID is configured.
3. Stop any copy of this bot running on your PC or another server before starting the cloud worker. Only one polling process should use the token.

## Create the worker

1. Sign in at https://dashboard.render.com.
2. Choose New > Background Worker.
3. Select the Git repository KapitalV/Telespark and branch `main`. If the repository is public, Render may offer Public Git Repository; if GitHub authorization is required, limit it to this repository where possible.
4. Choose Docker as the runtime. Keep the root directory empty and use the repository's `Dockerfile`.
5. Name the worker `telespark`. Select a region offered in your account.
6. Select a paid compute plan with enough memory for a Node.js process and Chromium. A 2 GB plan is a reasonable starting point, but actual browser memory usage must be checked. Review the current dashboard price before committing to a plan. Keep the worker at one instance.
7. Add these environment variables directly in Render:

| Name | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Your replacement token from BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID, or omit initially for `/id` setup |
| `HEADLESS` | `true` |
| `BROWSER_CHANNEL` | `chromium` |

8. Use the Dockerfile's default start command, `node bot.mjs`. Do not override it with `npm start`: the local npm start script requires a `.env` file, whereas Render injects environment variables directly.
9. Review the selected paid plan and click Deploy only after you have approved the cost.

## Check the deployment

1. Wait for the Docker build and worker startup to complete.
2. Logs should show `Connected to @<your-bot-name>. Owner-only recovery enabled.` If they show setup mode instead, send `/id` in Telegram, add the returned ID in Render, and redeploy.
3. Send `/help` in a private Telegram chat. Check that the bot responds with its commands.
4. Send `/start`, answer the six questions, and verify that the CAPTCHA image arrives. Send `/cancel` if you are only testing the conversation and do not want to submit recovery.
5. For a real recovery, reply with the CAPTCHA characters. Confirm the latest password and slip arrive, then use `/result` to resend that result without another recovery submission.

The worker continues operating while your PC is off. A host outage, deploy, or restart can interrupt an in-progress conversation. This version keeps sessions in memory, so after a restart send `/start` again. Completed results are held in memory for twenty minutes and are also delivered to Telegram. This is continuous hosting, not a guarantee of uninterrupted availability.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Startup fails before connecting | Token is present, valid, and not revoked |
| Browser executable not found | Docker image version matches the pinned Playwright package; channel is `chromium` |
| Bot only responds to `/id` | Set the correct numeric owner ID and redeploy |
| Polling repeatedly disconnects | Stop other copies of the bot using this token; check Telegram connectivity |
| Worker is killed during browser use | Check the host's memory metrics and chosen compute plan |
| Website cannot load | Check the official site's availability and whether it accepts traffic from the selected cloud region |
| Submission outcome is unknown | Check the official website before deliberately submitting another recovery |

Do not print the token or password in logs, put secrets in the Dockerfile, or commit a populated `.env`.

Official references:

- https://render.com/docs/background-workers
- https://render.com/docs/docker
- https://render.com/docs/compute-plans
- https://playwright.dev/docs/docker
