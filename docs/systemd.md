# systemd

The installer script (`sudo ./scripts/install-systemd.sh`) sets up and starts a systemd user unit automatically. To configure it manually:

## User unit

Create `~/.config/systemd/user/antigravity-proxy.service`:

```ini
[Unit]
Description=antigravity-proxy: OpenAI-compatible relay over Google AI Pro OAuth
After=network-online.target

[Service]
ExecStart=/usr/bin/node /path/to/antigravity-proxy/src/cli.js
WorkingDirectory=/path/to/antigravity-proxy
Restart=on-failure
RestartSec=3
Environment=NO_PROXY=*

[Install]
WantedBy=default.target
```

Reload the systemd user daemon, then enable and start the service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now antigravity-proxy.service
```

Enable lingering so the process persists after logout:

```bash
loginctl enable-linger "$USER"
```

Verify that the service is running and healthy:

```bash
systemctl --user status antigravity-proxy
curl -sS http://127.0.0.1:8317/health
```

Follow the logs:

```bash
journalctl --user -u antigravity-proxy -f
```

## Configuration

You can either edit `config.json` (copy it from `config.example.json`) or define environment variables directly in the service unit:

| Variable | Description | Default |
|---|---|---|
| `ANTIGRAVITY_PROXY_PORT` | Listen port | 8317 |
| `ANTIGRAVITY_PROXY_HOST` | Listen host | 127.0.0.1 |
| `ANTIGRAVITY_PROXY_API_KEY` | API key required from clients | none |
| `ANTIGRAVITY_PROXY_LOG_LEVEL` | Log level (debug/info/warn/error) | info |
| `ANTIGRAVITY_PROXY_UPSTREAM` | Override Cloud Code base URL | daily-cloudcode-pa.googleapis.com |
