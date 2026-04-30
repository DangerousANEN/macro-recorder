# Установка Macro Recorder на Windows

Гайд для свежего Windows 10/11. Можно копировать команды агенту в PowerShell —
всё проверено для Windows PowerShell 5.1 и PowerShell 7+.

## TL;DR

```powershell
# 1. Node.js LTS (через winget)
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements

# 2. Git
winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements

# 3. Клон + установка
git clone https://github.com/DangerousANEN/macro-recorder.git C:\macro-recorder
cd C:\macro-recorder\server
npm install
npx playwright install chromium

# 4. Старт
npm start
```

Открой <http://localhost:3700>.

---

## Шаги подробно

### 1. Node.js 20 LTS

Macro Recorder тестируется на Node 20+.

```powershell
winget install --id OpenJS.NodeJS.LTS -e
node --version    # должен быть v20.x или новее
npm --version
```

Альтернатива без winget — установщик с <https://nodejs.org/>.

После установки **закрой и заново открой PowerShell**, иначе `node` не будет в
PATH в текущей сессии.

### 2. Git

```powershell
winget install --id Git.Git -e
git --version
```

### 3. Клонирование репозитория

Можно положить куда угодно — пример в `C:\macro-recorder`. Избегай путей с
кириллицей и пробелами (Playwright capricious).

```powershell
git clone https://github.com/DangerousANEN/macro-recorder.git C:\macro-recorder
cd C:\macro-recorder
```

### 4. Установка зависимостей сервера

```powershell
cd C:\macro-recorder\server
npm install
```

Если `npm install` падает с ошибкой по нативным модулям — установи Build Tools:

```powershell
npm install --global windows-build-tools  # старые системы
# или
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--add Microsoft.VisualStudio.Workload.VCTools --quiet --norestart"
```

### 5. Playwright Chromium

Macro Recorder использует только Chromium.

```powershell
cd C:\macro-recorder\server
npx playwright install chromium
```

Скачается ~150 МБ. Если поднимается прокси/файрвол, установи переменную:

```powershell
$env:HTTPS_PROXY = "http://user:pass@proxy:8080"
npx playwright install chromium
```

### 6. (Опционально) MCP-сервер для LLM-агента

```powershell
cd C:\macro-recorder\mcp
npm install
```

См. отдельный раздел "Подключение MCP к агенту" ниже.

### 7. Запуск сервера

```powershell
cd C:\macro-recorder\server
npm start
```

Должно вывести:

```
🚀 Macro Recorder Server: http://127.0.0.1:3700
📁 Data directory: C:\macro-recorder\data
```

Открой <http://localhost:3700> в Chrome — это редактор макросов.

### 8. (Опционально) Chrome-расширение для записи

В Chrome:
1. `chrome://extensions/`
2. Включи **Developer mode**
3. **Load unpacked** → выбери `C:\macro-recorder\extension`
4. На иконке расширения нажми **Connect**, кнопка станет зелёной

После этого сайт `http://localhost:3700` сможет получать записанные действия.

---

## Запуск как фоновый Windows-сервис (рекомендуется для агента)

Чтобы сервер сам поднимался при старте Windows и не висел в окне PowerShell.
Используем **NSSM** (Non-Sucking Service Manager).

```powershell
# 1. Установить NSSM
winget install --id NSSM.NSSM -e

# 2. Создать сервис
$node = (Get-Command node).Source
nssm install MacroRecorder $node "C:\macro-recorder\server\index.js"
nssm set MacroRecorder AppDirectory "C:\macro-recorder\server"
nssm set MacroRecorder AppEnvironmentExtra "PORT=3700" "HOST=127.0.0.1"
nssm set MacroRecorder AppStdout "C:\macro-recorder\logs\out.log"
nssm set MacroRecorder AppStderr "C:\macro-recorder\logs\err.log"
nssm set MacroRecorder Start SERVICE_AUTO_START
mkdir C:\macro-recorder\logs -Force | Out-Null

# 3. Запустить
nssm start MacroRecorder

# 4. Управление
nssm status MacroRecorder       # SERVICE_RUNNING / STOPPED
nssm stop  MacroRecorder
nssm restart MacroRecorder
nssm remove MacroRecorder confirm   # удалить сервис целиком
```

Логи смотри в `C:\macro-recorder\logs\out.log` и `err.log`.

### Альтернатива без NSSM — pm2

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd C:\macro-recorder\server
pm2 start index.js --name macro-recorder
pm2 save
```

---

## Подключение MCP к агенту

MCP-сервер общается через stdio — клиент сам поднимает дочерний процесс
`node mcp/index.js`. Главное — указать абсолютный путь.

### Claude Desktop

Открой `%APPDATA%\Claude\claude_desktop_config.json` (создай, если нет):

```json
{
  "mcpServers": {
    "macro-recorder": {
      "command": "node",
      "args": ["C:\\macro-recorder\\mcp\\index.js"],
      "env": {
        "MCP_RECORDER_URL": "http://127.0.0.1:3700"
      }
    }
  }
}
```

Перезапусти Claude Desktop. В чате появится иконка молотка с 13 tools.

### Cursor

`%APPDATA%\Cursor\User\mcp.json` (или Settings → MCP):

```json
{
  "mcpServers": {
    "macro-recorder": {
      "command": "node",
      "args": ["C:\\macro-recorder\\mcp\\index.js"],
      "env": { "MCP_RECORDER_URL": "http://127.0.0.1:3700" }
    }
  }
}
```

### Devin / Continue / любой MCP-клиент

Тот же шаблон. Команда: `node`, аргумент: абсолютный путь к `mcp\index.js`,
переменная окружения `MCP_RECORDER_URL` указывает на работающий сервер.

### Проверка

```powershell
cd C:\macro-recorder\server
$env:SMOKE_PORT = 3801
node ..\scripts\smoke-mcp.mjs    # должно выдать "MCP SMOKE: PASS"
```

---

## Куда что сохраняется

| Путь | Что |
| --- | --- |
| `C:\macro-recorder\data\macros\*.json` | Макросы |
| `C:\macro-recorder\data\snapshots\` | Скриншоты (auto-GC при старте) |
| `C:\macro-recorder\data\profiles\` | Chromium-профили (логин/cookies/2FA) |
| `C:\macro-recorder\data\settings.json` | Глобальные настройки |
| `C:\macro-recorder\data\persistent-vars.json` | Persistent variables |
| `C:\macro-recorder\logs\` | Логи сервиса (если NSSM/pm2) |

Бэкапь `data\` целиком — в нём всё пользовательское.

---

## Переменные окружения

Можно класть в `C:\macro-recorder\server\.env` (формат `KEY=value` по
строкам). Самые полезные:

| Var | Default | Зачем |
| --- | --- | --- |
| `PORT` | `3700` | Порт сервера |
| `HOST` | `127.0.0.1` | Только localhost. Поставь `0.0.0.0` если нужен доступ из локальной сети (не делай если Windows смотрит в интернет!) |
| `SNAPSHOT_GC_ON_BOOT` | `1` | Запускать GC скриншотов при старте |
| `RUNTIME_SNAPSHOT_MAX_AGE_DAYS` | `7` | Сколько дней хранить runtime-скриншоты |
| `EDITOR_SNAPSHOT_MAX_AGE_DAYS` | `30` | Сколько дней хранить editor-скриншоты |
| `SNAPSHOT_KEEP_PER_DIR` | `200` | Максимум файлов в директории скриншотов |
| `MACRO_RUN_HARD_TIMEOUT_MS` | `120000` | Hard timeout одного прогона |
| `MCP_RECORDER_URL` | `http://127.0.0.1:3700` | URL сервера для MCP-клиента |

---

## Troubleshooting

### `npm start` падает на `Error: Cannot find module 'playwright'`
Не сделал `npm install` или сделал не в `server/`. Перейди в `server\` и
повтори.

### Браузер открывается, но `Failed to launch chromium`
```powershell
cd C:\macro-recorder\server
npx playwright install chromium
```
Если сидишь за прокси, выстави `HTTPS_PROXY` перед командой.

### Antivirus / SmartScreen блокирует chromium.exe
Добавь `C:\macro-recorder` в исключения Windows Defender:
```powershell
Add-MpPreference -ExclusionPath "C:\macro-recorder"
```

### Порт 3700 занят
```powershell
netstat -ano | findstr 3700
taskkill /F /PID <PID>
# или сменить порт
$env:PORT=3701; npm start
```

### `npm install` с EACCES / EPERM
Не запускай PowerShell от имени администратора без причины. Если папка под
`C:\Program Files` — перенеси проект в `C:\macro-recorder` или
`%USERPROFILE%\macro-recorder`.

### MCP-клиент не видит tools
1. Проверь, что путь в конфиге **абсолютный** и с `\\` (двойной слэш в JSON).
2. Перезапусти клиент полностью (Claude Desktop — выйти из трея, не просто
   закрыть окно).
3. Запусти руками `node C:\macro-recorder\mcp\index.js` — должен вывести
   `[macro-recorder-mcp] ready, base=http://127.0.0.1:3700`. Если падает —
   значит сервер на `MCP_RECORDER_URL` не отвечает; запусти его сначала.

### Сервер запущен, но `http://localhost:3700` не открывается
Проверь, что `HOST=127.0.0.1` (а не какой-то другой адрес), и нет VPN/Hyper-V
адаптера, перехватывающего localhost. Открой `http://127.0.0.1:3700` напрямую.

---

## Обновление

```powershell
cd C:\macro-recorder
git pull
cd server
npm install        # на случай новых зависимостей
nssm restart MacroRecorder   # или pm2 restart macro-recorder, или просто перезапусти npm start
```

Перед обновлением сделай бэкап `data\` если боишься.
