# WM Plus Monitoring

WM Plus Monitoring is a custom dashboard built by Webmarketers to automate and monitor the visual consistency and functional health of client websites. It leverages BackstopJS for visual regression testing and an automated cron scheduler to ensure that sites are continuously monitored for unexpected layout changes or broken forms.

## Features

- **Visual Regression Testing**: Automatically takes baseline screenshots and compares them on a scheduled basis using BackstopJS.
- **Form Testing via WordPress Plugin**: Integrates directly with client WordPress environments utilizing Gravity Forms (via the WM Monitor plugin) to ensure lead generation pipelines are functional.
- **Robust Alerting**: Real-time notifications via Slack Webhook and Email targeting (using AWS SES or standard SMTP).
- **Per-Site Overrides**: Set custom automated checking schedules and visual mismatch thresholds (e.g. 1% vs 5%) on a site-by-site basis.
- **Digital Ocean Sync**: Seamlessly deploy the application to a live DigitalOcean environment using the provided `deploy.sh` script.

## Tech Stack

- **Backend**: Node.js, Express, SQLite3 (via Knex)
- **Frontend**: Vanilla JavaScript (SPA), HTML, CSS
- **Workers/Testing**: BackstopJS, Node-Cron, Playwright/Puppeteer
- **Notifications**: AWS SDK (SES), Nodemailer, Slack Webhooks

## Quick Start (Local Setup)

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   Rename `.env.example` to `.env` if one is provided, or create one manually.
   The project will automatically create an SQLite database (`wm-monitoring.db`) dynamically on launch.

3. **Start the Development Server**
   ```bash
   # Starts with Nodemon for hot-reloading
   npm run dev

   # Or standard execution
   npm start
   ```
   The dashboard will be available at `http://localhost:3000`.

## Deployment

To deploy this application to your DigitalOcean droplet (`backstop.webmarketersdev.ca`):

```bash
npm run deploy
```

> **Note**: The deploy script utilizes `rsync` over SSH to push the code and restarts PM2. Ensure you have SSH access to the droplet before executing.

## Architecture & Data Storage

- `server.js`: The main Express server and SPA routing entry point.
- `db.js`: Knex schema initialization, migrations, and database queries.
- `public/`: Static files (app.js, app.css, index.html) for the dashboard frontend.
- `clients/`: Specific Backstop generated snapshots per client.
- `Backstop-Monitoring/`: Configuration parameters and shell scripts to trigger Backstop tests manually.

## Security Considerations

To protect organizational secrets:
- Keep the `AWS` and `SMTP` configurations exclusively in the database or dashboard settings.
- Avoid hardcoding API keys, WP keys, or Slack Webhooks anywhere into scripts or plain `.env` files committed to Git.
