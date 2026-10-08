# Keep this version aligned with package.json and package-lock.json.
FROM mcr.microsoft.com/playwright:v1.64.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy only program files: never bake .env or recovery results into the image.
COPY --chown=pwuser:pwuser bot.mjs core.mjs portal.mjs ./

ENV NODE_ENV=production
ENV HEADLESS=true
ENV BROWSER_CHANNEL=chromium

USER pwuser
CMD ["node", "bot.mjs"]
