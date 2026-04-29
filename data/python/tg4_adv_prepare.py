import os

# Variables from macro are injected into globals() by runner.
# Expected inputs:
# - botname: raw value from table column
# - p_row_index: persistent row counter (string/int)
# Output vars we set:
# - p_row_index, searchq, already_read ('0'/'1'), need_switch ('0'/'1'), target_profile

DATA_ROOT = r"F:\ANEN\Desktop\macro-recorder-debug\data"
READED_PATH = os.path.join(DATA_ROOT, "readed.csv")

_raw = (globals().get('botname') or '')
raw = str(_raw).strip()
# user asked botname[1] — interpret as first token before whitespace
bot = raw.split()[0].strip() if raw else ''

# Normalize: table should contain base names like "claw343" (NO "_bot").
# If a row accidentally contains "_bot" suffix, strip it.
if bot and bot.lower().endswith('_bot'):
    bot = bot[:-4]

try:
    idx = int(globals().get('p_row_index') or 0)
except Exception:
    idx = 0
idx += 1

# Switch profile every 25 rows: 1-25 tg, 26-50 tg2, 51-75 tg ...
bucket = (idx - 1) // 25
profile = 'tg' if (bucket % 2 == 0) else 'tg2'
need_switch = '1' if idx == 1 else ('1' if ((idx - 1) % 25 == 0) else '0')

# readed.csv membership
already = False
if not bot:
    already = True

if bot:
    try:
        with open(READED_PATH, 'r', encoding='utf-8') as f:
            for line in f:
                v = line.strip()
                if v == bot or v == (bot + '_bot'):
                    already = True
                    break
    except FileNotFoundError:
        pass

# If not read, append immediately (so reruns don't duplicate work)
if bot and (not already):
    os.makedirs(os.path.dirname(READED_PATH), exist_ok=True)
    with open(READED_PATH, 'a', encoding='utf-8', newline='') as f:
        f.write(bot + "\n")

p_row_index = str(idx)
searchq = bot.lower()
already_read = '1' if already else '0'
need_switch = need_switch
target_profile = profile

# Direct-open URLs for Telegram Web (avoid relying on left dialog list/search DOM)
try:
    from urllib.parse import quote
except Exception:
    def quote(s, safe=''):
        return s

tgaddr = f"tg://resolve?domain={bot}"
tg_open_url_a = f"https://web.telegram.org/a/#?tgaddr={quote(tgaddr, safe='') }"
tg_open_url_k = f"https://web.telegram.org/k/#?tgaddr={quote(tgaddr, safe='') }"
# Prefer /a/ by default (macro can switch to _k if needed)
tg_open_url = tg_open_url_a

# Debug note written back to bots.csv by server/bots-process.js (if non-empty)
bot_notes = f"searchq={searchq}; already_read={already_read}; tg_open_url={tg_open_url}"
