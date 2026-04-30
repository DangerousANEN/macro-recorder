import { readFileSync, writeFileSync } from 'fs';

const file = 'F:\\ANEN\\Desktop\\macro-recorder-debug\\data\\macros\\tg3-rotate-001.json';
const json = JSON.parse(readFileSync(file, 'utf-8'));

// Find the python check step inside loop
const loop = json.steps.find(s => s.action === 'loop');
const pyCheck = loop.children.find(s => s.pythonCode && s.pythonCode.includes('readed.csv'));

if (!pyCheck) { console.log('Check step not found!'); process.exit(1); }

const newCode = `import csv
import os
import sys

if sys.platform == 'win32':
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

# Нормализуем имя бота
currentbot = currentbot.strip().replace('\\n', '').replace('\\r', '')

filename = 'F:\\\\ANEN\\\\Desktop\\\\macro-recorder-debug\\\\data\\\\.tmp\\\\readed.csv'
rows = []

with open(filename, 'r', newline='', encoding='utf-8') as f:
    reader = csv.reader(f)
    rows = list(reader)

# Множество для быстрой проверки
existing = set(row[0] for row in rows if row)

# Проверка: имя должно заканчиваться на 'bot'
if not currentbot.lower().endswith('bot'):
    print(f'{currentbot} -- not a bot, skip')
    stopflag = 1
# Проверка наличия
elif currentbot in existing:
    print(f'{currentbot} уже в таблице, skip')
    stopflag = 1
else:
    rows.append([currentbot])
    stopflag = 0
    # Записываем сразу
    with open(filename, 'w', newline='', encoding='utf-8') as f:
        writer = csv.writer(f)
        writer.writerows(rows)`;

pyCheck.pythonCode = newCode;
pyCheck.value = newCode;

writeFileSync(file, JSON.stringify(json, null, 2));
console.log('Fixed! Python check step updated.');
console.log('Code preview:', newCode.substring(0, 100));
