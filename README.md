# KOL Radar

This project provides a focused workspace for Aliyun Enterprise Mail, YouTube, and Instagram. It only displays data returned by configured official APIs.

## Railway deployment

1. Deploy this repository to one stable Node host (Railway, Render, or a VPS).
2. Add every required variable from `.env.example` to the host's server-side Variables page.
3. Set `MAIL_IMAP_PASSWORD` to the Aliyun Enterprise Mail app password. Do not put secrets in GitHub or the browser.
4. Set `KOL_ADMIN_TOKEN` to a long random value. The browser prompts for it only for write actions.
5. Put the generated service URL into the dashboard's **连接设置** page.

### Mail translation with LibreTranslate

The mailbox scanner uses self-hosted [LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) and no longer calls Gemini. Start it locally with `docker compose -f docker-compose.libretranslate.yml up -d`, or deploy the same container on a server. Put its public base URL in `LIBRETRANSLATE_URL` and, if enabled, its key in `LIBRETRANSLATE_API_KEY`. The scanner stores the original English in `body` and the Chinese result in `bodyChinese`; translation errors are kept in `translationStatus` instead of being replaced with invented text.

The server checks the mailbox at `SCAN_HOUR`:`SCAN_MINUTE` in `APP_TIMEZONE`, and exposes the most recent scan at `/api/digest`.

### YouTube

`YOUTUBE_API_KEY` enables public video and comment reads. Publishing and replying to comments require Google OAuth with `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, and `YOUTUBE_REFRESH_TOKEN`.

### Instagram

Instagram requires a professional Instagram account connected to a Facebook Page and a Meta Graph API access token. Set `INSTAGRAM_USER_ID` and `INSTAGRAM_ACCESS_TOKEN`. Ordinary personal Instagram accounts are not supported by these publishing endpoints.

## Local run

```powershell
npm install
npm start
```

Open `http://localhost:3000`.
