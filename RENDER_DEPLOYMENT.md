# Render Free Tier Deployment & Operational Guide

This document provides instructions for deploying and running the **Corporate Intelligence Crawler** (`app.py`) on the **Render Free Tier** under a strict **256MB RAM ceiling**.

---

## 1. Architecture & Resource Allocation

| Resource | Render Free Tier Specification | Crawler Consumption | Operational Safety Margin |
| :--- | :--- | :--- | :--- |
| **CPU** | 0.1 vCPU (shared, throttled) | Bursts during HTML parsing (200-500ms) | Low CPU usage, non-blocking sync workers |
| **RAM Ceiling** | 512MB max allocated / **256MB safe ceiling** | **45MB–65MB per worker** (Total ~120MB) | **>130MB buffer** before Linux OOM killer |
| **Ephemeral Disk** | Non-persistent container storage | 0 MB disk used (100% in-memory) | Stateless; no files saved to local disk |
| **Network** | Outbound ports 80, 443 open | HTTPS to Serper API and target websites | Unrestricted outbound traffic |
| **Inactivity Policy** | Spins down after 15 min of idle time | Cold start takes 45–60 seconds | Preventable via pinging `/health` |

---

## 2. Deployment Method A: Blueprint Deployment (render.yaml)

The repository includes a ready-to-use `render.yaml` specification.

### Steps:
1. Push this repository to your GitHub or GitLab account.
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** ➔ **Blueprint**.
3. Connect your repository.
4. Render will parse `render.yaml` automatically:
   ```yaml
   services:
     - type: web
       name: corporate-intel-bridge
       env: python
       region: oregon
       plan: free
       buildCommand: pip install -r requirements.txt
       startCommand: gunicorn -w 2 -b 0.0.0.0:$PORT --timeout 120 --worker-tmp-dir /dev/shm app:app
       envVars:
         - key: PYTHON_VERSION
           value: 3.11.8
         - key: SERPER_API_KEY
           sync: false
   ```
5. When prompted for `SERPER_API_KEY`, input your Serper.dev API key.
6. Click **Apply**. Render will trigger the build and deploy.

---

## 3. Deployment Method B: Manual Web Service Setup

If setting up without Blueprints:

1. In Render Dashboard, click **New +** ➔ **Web Service**.
2. Connect your Git repository.
3. Configure the following fields:
   - **Name:** `corporate-intel-bridge` (or custom name)
   - **Region:** `Oregon (US West)` or `Frankfurt (EU Central)`
   - **Branch:** `main`
   - **Root Directory:** *(leave blank for repository root)*
   - **Runtime:** `Python 3`
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:**
     ```bash
     gunicorn -w 2 -b 0.0.0.0:$PORT --timeout 120 --worker-tmp-dir /dev/shm app:app
     ```
   - **Instance Type:** `Free`
4. Expand **Environment Variables** and add:
   - `PYTHON_VERSION` = `3.11.8`
   - `SERPER_API_KEY` = `<your-serper-api-key>`
5. Expand **Advanced**:
   - **Health Check Path:** `/health`
   - **Auto-Deploy:** `Yes`
6. Click **Create Web Service**.

---

## 4. Understanding the Production Start Command

The start command is tuned specifically to operate within Render's free tier constraints:

```bash
gunicorn -w 2 -b 0.0.0.0:$PORT --timeout 120 --worker-tmp-dir /dev/shm app:app
```

### Breakdown of Parameters:
1. `-w 2` (**Two Sync Workers**):
   - A single Flask process uses ~25MB baseline memory and ~55MB under parsing load.
   - Two workers consume ~110MB–130MB total, safely below the 256MB threshold.
   - **Warning:** Setting `-w 4` or higher will cause memory usage to exceed 256MB during concurrent requests, causing Render to terminate the container with **Exit Code 137 (OOM Killed)**.
2. `--timeout 120` (**120-Second Worker Timeout**):
   - Gunicorn defaults to a 30-second worker timeout.
   - A deep crawl can take 15–35 seconds if upstream portals take long to respond or trigger the Serper Gateway fallback. 120 seconds prevents Gunicorn from prematurely killing active scraping workers.
3. `--worker-tmp-dir /dev/shm` (**Shared Memory for Heartbeats**):
   - In containerized environments (Docker/Render), Gunicorn worker heartbeat files stored on the standard filesystem can experience IO blocking and phantom timeouts.
   - Using `/dev/shm` places heartbeat files in Linux RAM disk, ensuring zero filesystem latency.
4. `-b 0.0.0.0:$PORT`:
   - Binds to all network interfaces on the dynamic port assigned by Render via the `$PORT` environment variable.

---

## 5. Storage, Cold Starts & Background Worker Considerations

### Storage:
- Render Free instances have an ephemeral filesystem. Any file written to disk is destroyed upon restart.
- The crawler is 100% stateless and stores no files on disk.

### Cold Start Management:
- Free tier instances spin down after 15 minutes of zero inbound traffic.
- Cold boots take **45 to 60 seconds** on the next incoming request.
- **Remedy:** If integration with your financial intelligence platform requires zero cold starts:
  - Configure a free external monitor (e.g., UptimeRobot, BetterUptime) to send a `GET /health` request every 10 minutes.
  - Or upgrade the instance to Render's **Starter Plan ($7/month)**, which disables spin-down and provides 512MB RAM + 0.5 CPU.

### Background Queue / Asynchronous Tasks:
- In the current code, `/google_and_deep_scrape` is a **synchronous request-response endpoint**.
- If your platform handles heavy batch crawls (e.g., 50+ companies at once), do not hit this endpoint concurrently from a single thread. Run an external background queue (such as Celery, RQ, or BullMQ) in your primary platform that calls this microservice at a controlled rate of **1 to 2 concurrent requests**.

---

## 6. Verifying Production Deployment

Once the build completes and Render shows `Live`:

```bash
# 1. Test Health Endpoint
curl -s https://your-service.onrender.com/health
# Expected: {"serper_configured":true,"status":"healthy","timestamp":...}

# 2. Test Live Crawl
curl -s -X POST https://your-service.onrender.com/google_and_deep_scrape \
  -H "Content-Type: application/json" \
  -d '{"query":"Wabtec Corporation"}' | head -c 250
```
