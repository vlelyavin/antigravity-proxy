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
| `ANTIGRAVITY_PROXY_VERTEX_FALLBACK` | vertex fallback: a url enables the relay it names, `on`/`true`/`1` enable the configured url, `off`/`none` disable | off |

the fallback is off by default: it switches provider and strips the model's effort suffix, so enabling
it is a deliberate decision. per-account exits (`upstream.egress.accounts` in `config.json`) are not
env-configurable; the relay refuses an account with no exit and an account whose exit another account
already holds (`egress.duplicate` in the journal), and keeps serving the rest.
