# antigravity-proxy

[English README](README.md)

у тебя есть подписка google ai pro. твоим инструментам нужен openai-эндпоинт. посередине стоит это: локальный релей, который прогоняет openai chat-completions через oauth антигрэвити / code assist — hermes, opencode и всё openai-совместимое ездят на подписке вместо поминутного билла.

## что делает

- читает локальный oauth-токен antigravity/gemini с диска на каждый запрос — свежий логин где-то ещё подхватывается без рестарта
- переводит openai `chat/completions` ↔ cloud code `generateContent` структурно, в обе стороны, включая tool calls и картинки
- стримит: openai SSE из cloud-code SSE-кадров
- мультиаккаунт round-robin с cooldown на 429 — положи N файлов с токенами и он ротирует
- ретраит 5xx/сеть с бэкоффом; квотные ошибки не валят запрос, а переключают аккаунт
- опциональный api key, чтобы порт не был бесплатным для всей локалки
- ноль зависимостей. только stdlib node.

## чем не является

- не продукт google, никак с ними не связан
- не хостед-сервис — работает на твоей машине, твои креды
- не бандл кредов — в репо ничего приватного нет

## честно

использует подписочный oauth вне официального клиента. серая зона tos google — тот же клуб, что у всех code-assist прокси. выжмёшь — можно потерять подписку; квота пер-юзер (~1500 запросов/день на ai pro), и один агентный промпт жжёт несколько запросов. твоё решение.

## требования

- node 20+ (без сборки, без npm install)
- локальный oauth-токен из одного из:
  - **antigravity cli** (`agy`) → `~/.gemini/antigravity-cli/antigravity-oauth-token`
  - **gemini cli** (`npm i -g @google/gemini-cli && gemini`) → `~/.gemini/oauth_creds.json`
  - любой файл с `{access_token, refresh_token, project_id?}` в `~/.antigravity-proxy/accounts/*.json`

## запуск

```bash
git clone https://github.com/vlelyavin/antigravity-proxy.git
cd antigravity-proxy
node src/cli.js
```

слушает `127.0.0.1:8317`.

```bash
curl -sS http://127.0.0.1:8317/health
```

health показывает все найденные аккаунты и срок токена. дальше:

```bash
curl -sS http://127.0.0.1:8317/v1/chat/completions \
  -H 'content-type: application/json' \
  --data '{"model":"gemini-3.8-flash-high","messages":[{"role":"user","content":"reply with exactly: pong"}]}'
```

`pong` — весь путь работает.

## подключение к инструментам

openai-совместимый base url `http://127.0.0.1:8317/v1`, api key — что выставил (или `none`).

opencode:

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "provider": {
    "antigravity": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:8317/v1", "apiKey": "none" },
      "models": {
        "gemini-3.8-flash-high": { "limit": { "context": 1048576, "output": 65536 } },
        "gemini-3.1-pro-high": { "limit": { "context": 1048576, "output": 65536 } }
      }
    }
  }
}
```

hermes / любой openai sdk: `base_url=http://127.0.0.1:8317/v1`, `api_key=none`, id моделей из `GET /v1/models`.

## модели

`gemini-3.8-flash-{low,medium,high}`, `gemini-3.7/3.6-flash-*`, `gemini-3-flash`, `gemini-3.1-pro-{low,high}`, `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, `gpt-oss-120b-medium`. список лежит в `src/rewrite/openai-translate.js` — дополняй, когда google завезёт новые.

## мультиаккаунт

доложи дополнительные токен-файлы в `~/.antigravity-proxy/accounts/*.json` (формат: `{access_token, refresh_token, project_id?, email?}`). round-robin берёт следующий здоровый аккаунт; 429 ставит аккаунт на cooldown и пробует следующий. 2-3 аккаунта на один резидентский exit ip — разумный потолок; больше похоже на фермy, а фермы google встречает recaptcha.

## systemd

```bash
sudo ./scripts/install-systemd.sh
```

одна команда — пишет юнит, включает, стартует. ручной путь в `docs/systemd.md`.

## структура

```
src/
  config/         дефолты, env-оверрайды, лоадер
  credentials/    поиск токен-файлов (agy / gemini-cli / raw), oauth refresh
  rewrite/        openai <-> cloud code трансформы + каталог моделей
  upstream/       клиент cloud code с ретраями, пул аккаунтов с cooldown
  server/         http: /health, /v1/models, /v1/chat/completions
test/             22 теста, без сети
```

## безопасность

- только localhost, если точно не знаешь, зачем иначе
- никогда не коммить токен-файлы и config.json
- поставь `apiKey` в config.json, если к порту может достучаться не только твоя машина

## лицензия

MIT
