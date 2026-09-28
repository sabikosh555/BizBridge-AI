#!/usr/bin/env python3
"""AI Sana Challenge Hub. Python 3.10+, standard library only."""
import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
import uuid

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get('SANA_DB', ROOT / 'data' / 'hub.sqlite3'))
LOCK = threading.RLock()
FIELDS = ['title', 'context', 'need', 'users', 'data', 'constraints', 'result', 'criteria', 'contact', 'interaction']
LABELS = dict(zip(FIELDS, ['Название', 'Контекст', 'Потребность', 'Пользователи', 'Данные и материалы', 'Ограничения', 'Ожидаемый результат', 'Критерии успеха', 'Контакт', 'Формат взаимодействия']))
RUBRIC = [('context', 10), ('need', 10), ('data', 20), ('result', 15), ('criteria', 15), ('constraints', 10), ('users', 10), ('contact', 5), ('interaction', 5)]
TOPICS = ['Образование', 'Ритейл', 'Экология', 'Логистика', 'Сервисы']
AI_PROMPT = '''Ты помогаешь бизнесу уточнить задачу для студентов. Вход: JSON {draft, topic, fields}. Только факты пользователя. Не заполняй пропуски догадками. Верни JSON {mode, questions: [{field, question}], fields}. Не менее 3 уместных вопросов о пропущенных или неясных полях. fields содержит только предоставленные пользователем значения. Пользователь редактирует и подтверждает карточку. Не оценивай и не назначай команды.'''
QUESTIONS = {
 'context': 'Как сейчас устроен процесс и где возникает проблема?',
 'need': 'Что именно нужно изменить и почему это важно для бизнеса?',
 'users': 'Кто будет пользоваться решением и какую задачу эти люди решают?',
 'data': 'Какие данные, примеры или материалы вы можете предоставить команде?',
 'constraints': 'Какие есть сроки, технические ограничения и условия доступа?',
 'result': 'Что команда должна передать вам в конце: прототип, отчёт или работающий сервис?',
 'criteria': 'По каким измеримым показателям вы примете результат?',
 'contact': 'Какой рабочий контакт можно указать для связи с командой?',
 'interaction': 'Как часто вы готовы консультировать команду и давать обратную связь?',
}

def clean(value, limit=4000):
    if not isinstance(value, str):
        raise ValueError('Ожидалась текстовая строка.')
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f'Текст слишком длинный: максимум {limit} символов.')
    return value

def usable(value):
    text = value.strip().lower()
    return len(text) >= 3 and text not in {'нет', 'n/a', 'тест', 'потом', 'не знаю', '???', '...', 'уточним', 'неизвестно'}

def rating(fields, confirmed):
    items = [dict(field=f, label=LABELS[f], max=w, points=w if confirmed and usable(fields.get(f, '')) else 0) for f, w in RUBRIC]
    score = sum(i['points'] for i in items)
    level = 'Черновик' if score < 40 else 'Рабочая' if score < 70 else 'Готовая' if score < 90 else 'Приоритетная'
    return dict(score=score, level=level, breakdown=items, missing=[i for i in items if not i['points']])

def connect():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute('PRAGMA foreign_keys = ON')
    return con

def parse_task(row):
    task = dict(row)
    task['fields'] = json.loads(task['fields'])
    task['confirmed'] = bool(task['confirmed'])
    task.update(rating(task['fields'], task['confirmed']))
    return task

def demo_data():
    return json.loads((ROOT / 'fixtures' / 'demo-data.json').read_text(encoding='utf-8'))

def seeds():
    return demo_data()['tasks']

def init_db():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with connect() as con:
        con.executescript('''
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, topic TEXT NOT NULL, draft TEXT NOT NULL, fields TEXT NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY, name TEXT NOT NULL, interests TEXT NOT NULL, skills TEXT NOT NULL, technologies TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), team_id TEXT NOT NULL REFERENCES teams(id), idea TEXT NOT NULL, plan TEXT NOT NULL, duration TEXT NOT NULL, link TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS milestones(id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id), name TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', points INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        ''')
        if con.execute('SELECT COUNT(*) FROM tasks').fetchone()[0]:
            return
        dataset = demo_data()
        drafts = {d['task_id']: d['text'] for d in dataset['drafts']}
        for card in dataset['tasks']:
            con.execute('INSERT INTO tasks(id,topic,draft,fields,confirmed,published) VALUES(?,?,?,?,1,1)', (card['id'], card['topic'], drafts[card['id']], json.dumps(card['fields'], ensure_ascii=False)))
        for team in dataset['teams']:
            con.execute('INSERT INTO teams VALUES(?,?,?,?,?)', tuple(team[k] for k in ['id','name','interests','skills','technologies']))
        for proposal in dataset['proposals']:
            con.execute('INSERT INTO proposals(id,task_id,team_id,idea,plan,duration,link) VALUES(?,?,?,?,?,?,?)', tuple(proposal[k] for k in ['id','task_id','team_id','idea','plan','duration','link']))

def ai_questions(payload):
    draft = clean(payload.get('draft', ''))
    if len(draft) < 10:
        raise ValueError('Опишите задачу хотя бы в 10 символах.')
    topic = clean(payload.get('topic', 'Образование'), 100)
    source = payload.get('fields', {})
    if not isinstance(source, dict):
        raise ValueError('Поля карточки должны быть объектом.')
    fields = {f: clean(source.get(f, '')) for f in FIELDS}
    if not fields['context']:
        fields['context'] = draft
    missing = [f for f in QUESTIONS if not usable(fields[f])]
    selected = (missing + [f for f in QUESTIONS if f not in missing])[:max(3, len(missing))]
    questions = [{'field': f, 'question': QUESTIONS[f] if f in missing else f'Уточните поле «{LABELS[f]}»: достаточно ли информации для начала работы?'} for f in selected]
    if topic == 'Ритейл' and 'data' in selected:
        next(q for q in questions if q['field']=='data')['question'] = 'Есть ли история продаж, остатков или обращений? В каком формате и за какой период?'
    if topic == 'Образование' and 'users' in selected:
        next(q for q in questions if q['field']=='users')['question'] = 'Для кого решение: студентов, преподавателей или администраторов? Опишите их основную задачу.'
    result = dict(mode='local-stub', questions=questions, fields=fields)
    validate_ai_result(result, fields)
    return result

def validate_ai_result(result, source):
    if not isinstance(result, dict) or not isinstance(result.get('questions'), list) or len(result['questions']) < 3:
        raise ValueError('Некорректный AI-ответ: нужны минимум 3 вопроса.')
    if result.get('fields') != source:
        raise ValueError('AI-ответ содержит неподтверждённые факты.')
    for q in result['questions']:
        if not isinstance(q, dict) or q.get('field') not in QUESTIONS or not isinstance(q.get('question'), str) or len(q['question'].strip()) < 8:
            raise ValueError('Некорректная структура AI-вопроса.')
    return result

def url_ok(value):
    parsed = urlparse(value)
    return parsed.scheme in {'http', 'https'} and bool(parsed.hostname) and not parsed.username and not parsed.password

def require_role(payload, role):
    if payload.get('role') != role:
        raise ValueError('Переключитесь на соответствующую демо-роль.')

def mutate(path, p):
    with LOCK, connect() as con:
        if path == '/api/tasks':
            require_role(p, 'business')
            fields = p.get('fields', {})
            if not isinstance(fields, dict):
                raise ValueError('Поля карточки должны быть объектом.')
            fields = {f: clean(fields.get(f, ''), 160 if f=='title' else 4000) for f in FIELDS}
            if len(fields['title']) < 3:
                raise ValueError('Добавьте название: минимум 3 символа.')
            topic = p.get('topic')
            if topic not in TOPICS:
                raise ValueError('Выберите тему из списка.')
            confirmed = p.get('confirmed') is True
            published = p.get('published') is True
            if published and not confirmed:
                raise ValueError('Перед публикацией подтвердите карточку.')
            task_id = p.get('id') or str(uuid.uuid4())
            existing = con.execute('SELECT * FROM tasks WHERE id=?', (task_id,)).fetchone()
            if existing:
                if p.get('revision') != existing['revision']:
                    raise ValueError('Карточка уже изменилась. Обновите страницу перед сохранением.')
                if existing['published'] and not confirmed:
                    raise ValueError('Подтвердите изменения опубликованной карточки.')
                published = published or bool(existing['published'])
                con.execute('UPDATE tasks SET fields=?,topic=?,confirmed=?,published=?,revision=revision+1 WHERE id=?', (json.dumps(fields,ensure_ascii=False),topic,confirmed,published,task_id))
            else:
                con.execute('INSERT INTO tasks(id,topic,draft,fields,confirmed,published) VALUES(?,?,?,?,?,?)', (task_id,topic,clean(p.get('draft','')),json.dumps(fields,ensure_ascii=False),confirmed,published))
            return parse_task(con.execute('SELECT * FROM tasks WHERE id=?',(task_id,)).fetchone())
        if path == '/api/proposals':
            require_role(p, 'student')
            task = con.execute('SELECT * FROM tasks WHERE id=? AND published=1',(p.get('task_id'),)).fetchone()
            if not task or not con.execute('SELECT 1 FROM teams WHERE id=?',(p.get('team_id'),)).fetchone():
                raise ValueError('Задача или команда не найдена.')
            values = [clean(p.get(f,'')) for f in ['idea','plan','duration','link']]
            if any(len(v)<3 for v in values) or not url_ok(values[3]):
                raise ValueError('Заполните идею, план, срок и ссылку http(s) на прототип.')
            proposal_id = str(uuid.uuid4())
            con.execute('INSERT INTO proposals(id,task_id,team_id,idea,plan,duration,link) VALUES(?,?,?,?,?,?,?)',(proposal_id,p['task_id'],p['team_id'],*values))
            return {'id':proposal_id}
        if path == '/api/decision':
            require_role(p, 'business')
            status = p.get('status')
            if status not in {'selected','rejected','pending'}:
                raise ValueError('Неизвестное решение.')
            if con.execute('UPDATE proposals SET status=? WHERE id=?',(status,p.get('id'))).rowcount != 1:
                raise ValueError('Отклик не найден.')
            return {'ok':True}
        if path == '/api/milestones':
            require_role(p, 'student')
            proposal = con.execute('SELECT * FROM proposals WHERE id=? AND status=?',(p.get('proposal_id'),'selected')).fetchone()
            if not proposal or proposal['team_id'] != p.get('team_id'):
                raise ValueError('Отправить этап может только выбранная команда.')
            name, evidence = clean(p.get('name',''),200), clean(p.get('evidence',''))
            if len(name)<3 or not url_ok(evidence):
                raise ValueError('Добавьте название этапа и ссылку http(s) на результат.')
            mid = str(uuid.uuid4())
            con.execute('INSERT INTO milestones(id,proposal_id,name,evidence) VALUES(?,?,?,?)',(mid,proposal['id'],name,evidence))
            return {'id':mid}
        if path == '/api/milestones/confirm':
            require_role(p, 'business')
            row = con.execute('SELECT m.*, p.status AS proposal_status FROM milestones m JOIN proposals p ON p.id=m.proposal_id WHERE m.id=?',(p.get('id'),)).fetchone()
            if not row or row['proposal_status'] != 'selected':
                raise ValueError('Этап не найден или команда больше не выбрана.')
            con.execute("UPDATE milestones SET status='confirmed', points=20 WHERE id=? AND status='pending'",(row['id'],))
            return {'ok':True}
        raise ValueError('Неизвестное действие.')

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass
    def send_json(self, data, status=200):
        data = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(data)))
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/api/demo-data':
            return self.send_json(demo_data())
        if path == '/api/state':
            with connect() as con:
                tasks = [parse_task(r) for r in con.execute('SELECT * FROM tasks ORDER BY created DESC')]
                tasks.sort(key=lambda t:t['score'], reverse=True)
                teams = [dict(r) for r in con.execute('SELECT * FROM teams')]
                proposals = [dict(r) for r in con.execute('SELECT * FROM proposals ORDER BY created DESC')]
                milestones = [dict(r) for r in con.execute('SELECT * FROM milestones ORDER BY created DESC')]
            return self.send_json(dict(tasks=tasks,teams=teams,proposals=proposals,milestones=milestones,topics=TOPICS,labels=LABELS,rubric=RUBRIC,aiPrompt=AI_PROMPT))
        assets = {'/':('index.html','text/html'), '/app.js':('app.js','text/javascript'), '/style.css':('style.css','text/css')}
        if path not in assets:
            return self.send_json({'error':'Не найдено'},404)
        name, mime = assets[path]
        data=(ROOT/'static'/name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type',mime+'; charset=utf-8')
        self.send_header('Content-Length',str(len(data)))
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(data)
    def do_POST(self):
        origin = self.headers.get('Origin')
        if origin and urlparse(origin).netloc != self.headers.get('Host'):
            return self.send_json({'error':'Недопустимый источник запроса.'},403)
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0 < size <= 100_000:
                raise ValueError('Пустой или слишком большой запрос.')
            p=json.loads(self.rfile.read(size))
            if not isinstance(p, dict):
                raise ValueError('Ожидался JSON-объект.')
            path=urlparse(self.path).path
            self.send_json(ai_questions(p) if path=='/api/ai' else mutate(path,p))
        except (ValueError, TypeError, sqlite3.IntegrityError) as exc:
            self.send_json({'error':str(exc)},400)
        except Exception:
            self.send_json({'error':'Не удалось выполнить действие. Повторите попытку.'},500)

if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--port',type=int,default=8765)
    parser.add_argument('--host',default='127.0.0.1')
    args=parser.parse_args()
    init_db()
    server=ThreadingHTTPServer((args.host,args.port),Handler)
    print(f'AI Sana Hub → http://{args.host}:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()
