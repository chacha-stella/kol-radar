# KOL Radar

This project serves the KOL management dashboard and scans an Aliyun Enterprise Mail inbox each morning.

## Railway deployment

1. Create an empty GitHub repository and upload this folder.
2. In Railway, select **New Project** > **Deploy from GitHub repo** > select the repository.
3. Open the Railway service's **Variables** page and add the values from `.env.example`.
4. Set `MAIL_IMAP_PASSWORD` to a newly generated Aliyun Enterprise Mail app password. Do not add it to GitHub or chat.
5. Railway deploys automatically. Open the generated domain to use the dashboard.

The server checks the mailbox at `SCAN_HOUR`:`SCAN_MINUTE` in `APP_TIMEZONE`, and exposes the most recent scan at `/api/digest`.

## Local run

```powershell
npm install
npm start
```

Open `http://localhost:3000`.
