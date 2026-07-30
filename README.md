# KOL Radar

This project provides a focused workspace for Aliyun Enterprise Mail, YouTube, and Instagram. It only displays data returned by configured official APIs.

## Railway deployment

1. Deploy this repository to one stable Node host (Railway, Render, or a VPS).
2. Add every required variable from `.env.example` to the host's server-side Variables page.
3. Set `MAIL_IMAP_PASSWORD` to the Aliyun Enterprise Mail app password. Do not put secrets in GitHub or the browser.
4. Set `KOL_ADMIN_TOKEN` to a long random value. The browser prompts for it only for write actions.
5. Put the generated service URL into the dashboard's **连接设置** page.
6. For GitHub Actions to update the private dashboard digest, add `KOL_API_BASE` and `KOL_SCAN_TOKEN` to GitHub Secrets. Set the same random `KOL_SCAN_TOKEN` in Railway Variables.

### Mail translation with Argos Translate

The GitHub Actions mailbox job installs the open-source [Argos Translate](https://github.com/argosopentech/argos-translate) English/Chinese models and starts a temporary local HTTP bridge. No 24-hour translation server or extra Railway service is required. The scheduled scans run at 10:00 and 14:00 Beijing time (02:00 and 06:00 UTC). The scanner stores the original English in `body` and the Chinese result in `bodyChinese`; translation errors are kept in `translationStatus` instead of being replaced with invented text.

The GitHub Actions workflow scans at 10:00 and 14:00 Beijing time and uploads the private result to Railway through a token-protected endpoint. The server's optional in-process scan uses `SCAN_HOUR` and `SCAN_MINUTE`.

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
