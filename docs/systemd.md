# systemd

the installer (`sudo ./scripts/install-systemd.sh`) writes and starts a user unit. manual version:

## user unit

create `~/.config/systemd/user/antigravity-proxy.service`:

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

enable + start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now antigravity-proxy.service
```

linger, so it survives logout:

```bash
loginctl enable-linger "$USER"
```

check:

```bash
systemctl --user status antigravity-proxy
curl -sS http://127.0.0.1:8317/health
```

logs:

```bash
journalctl --user -u antigravity-proxy -f
```

## configuration

either edit `config.json` (copy from `config.example.json`) or use env vars in the unit:

| env | meaning | default |
|---|---|---|
| `ANTIGRAVITY_PROXY_PORT` | listen port | 8317 |
| `ANTIGRAVITY_PROXY_HOST` | listen host | 127.0.0.1 |
| `ANTIGRAVITY_PROXY_API_KEY` | require this key from clients | none |
| `ANTIGRAVITY_PROXY_LOG_LEVEL` | debug/info/warn/error | info |
| `ANTIGRAVITY_PROXY_UPSTREAM` | override cloud-code base url | daily-cloudcode-pa.googleapis.com |
