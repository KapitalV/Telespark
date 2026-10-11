# Keep this version aligned with package.json and package-lock.json.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy only program files: never bake .env or recovery results into the image.
COPY --chown=pwuser:pwuser bot.mjs core.mjs portal.mjs webhook.mjs probe.mjs router.mjs otr-core.mjs otr-portal.mjs otr-schema.mjs otr-recovery.mjs otr-diagnostics.mjs registration-core.mjs registration-portal.mjs access.mjs board-options.mjs activity.mjs ./
RUN mkdir -p /app/data && chown pwuser:pwuser /app/data

ENV NODE_ENV=production
ENV HEADLESS=true
ENV BROWSER_CHANNEL=chromium

USER pwuser
CMD ["node", "bot.mjs"]
