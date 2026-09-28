import json
from pathlib import Path
import tempfile
import unittest
import server

class HubTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old = server.DB_PATH
        server.DB_PATH = Path(self.temp.name)/'test.sqlite3'
        server.init_db()
    def tearDown(self):
        server.DB_PATH = self.old
        self.temp.cleanup()
    def task(self, **overrides):
        p=dict(role='business',topic='Ритейл',draft='Нужно сократить списания.',fields={'title':'Проверка задачи','context':'Каждый день списываем выпечку.'},confirmed=True,published=True)
        p.update(overrides)
        return server.mutate('/api/tasks',p)
    def proposal(self, task_id, team='u1'):
        return server.mutate('/api/proposals',dict(role='student',task_id=task_id,team_id=team,idea='Прогноз спроса',plan='Данные, базовая модель и прототип',duration='3 недели',link='https://example.com/prototype'))
    def test_seed_volume(self):
        with server.connect() as c:
            for table in ['tasks','teams','proposals']:
                self.assertGreaterEqual(c.execute('SELECT COUNT(*) FROM '+table).fetchone()[0],5)
            self.assertEqual([server.parse_task(r)['score'] for r in c.execute('SELECT * FROM tasks ORDER BY id')],[100,85,65,30,10])
    def test_fixture_contract(self):
        dataset=server.demo_data()
        for key in ['drafts','tasks','teams','proposals']:
            self.assertEqual(len(dataset[key]),5)
            self.assertEqual(len({r['id'] for r in dataset[key]}),5)
        tasks={t['id']:t for t in dataset['tasks']}
        teams={t['id']:t for t in dataset['teams']}
        for draft in dataset['drafts']:
            self.assertTrue(draft['text'])
            self.assertEqual(draft['industry'],tasks[draft['task_id']]['topic'])
        for task in tasks.values():
            self.assertEqual(set(task['fields']),set(server.FIELDS))
            self.assertEqual(task['score'],server.rating(task['fields'],task['confirmed'])['score'])
        self.assertEqual(len({p['idea'] for p in dataset['proposals']}),5)
        for proposal in dataset['proposals']:
            self.assertIn(proposal['task_id'],tasks)
            self.assertIn(proposal['team_id'],teams)
            self.assertTrue(all(proposal[f] for f in ['idea','plan','duration','link']))
            self.assertTrue(server.url_ok(proposal['link']))
        with server.connect() as con:
            for draft in dataset['drafts']:
                self.assertEqual(con.execute('SELECT draft FROM tasks WHERE id=?',(draft['task_id'],)).fetchone()[0],draft['text'])

    def test_rating_and_confirmation(self):
        fields={f:'Поле заполнено' for f in server.FIELDS}
        self.assertEqual(server.rating(fields,True)['score'],100)
        self.assertEqual(server.rating(fields,False)['score'],0)
        fields['data']='Не знаю'
        self.assertEqual(server.rating(fields,True)['score'],80)
        for n,level in [(0,'Черновик'),(40,'Рабочая'),(70,'Готовая'),(90,'Приоритетная'),(100,'Приоритетная')]:
            # Exhaustively find a field combination at each exact boundary.
            found=False
            for mask in range(512):
                f={k:'Заполнено' for i,(k,w) in enumerate(server.RUBRIC) if mask&(1<<i)}
                r=server.rating(f,True)
                if r['score']==n:
                    self.assertEqual(r['level'],level);found=True;break
            self.assertTrue(found)
    def test_publication_requires_confirmation(self):
        with self.assertRaises(ValueError): self.task(confirmed=False)
        self.assertFalse(self.task(confirmed=False,published=False)['confirmed'])
    def test_low_rating_does_not_block_proposals(self):
        t=self.task()
        self.assertEqual(t['score'],10)
        self.proposal(t['id'])
        self.proposal(t['id'])
    def test_unpublished_cannot_receive_proposals(self):
        t=self.task(published=False)
        with self.assertRaises(ValueError): self.proposal(t['id'])
    def test_manual_multiple_selection_and_progress(self):
        t=self.task()
        a,b=self.proposal(t['id']),self.proposal(t['id'],'u2')
        with self.assertRaises(ValueError): server.mutate('/api/milestones',dict(role='student',proposal_id=a['id'],team_id='u1',name='Прототип',evidence='https://example.com'))
        for p in [a,b]: server.mutate('/api/decision',dict(role='business',id=p['id'],status='selected'))
        with self.assertRaises(ValueError): server.mutate('/api/milestones',dict(role='student',proposal_id=a['id'],team_id='u2',name='Прототип',evidence='https://example.com'))
        m=server.mutate('/api/milestones',dict(role='student',proposal_id=a['id'],team_id='u1',name='Прототип',evidence='https://example.com'))
        for _ in range(2): server.mutate('/api/milestones/confirm',dict(role='business',id=m['id']))
        with server.connect() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM proposals WHERE task_id=? AND status='selected'",(t['id'],)).fetchone()[0],2)
            self.assertEqual(c.execute('SELECT SUM(points) FROM milestones').fetchone()[0],20)
    def test_revision_conflicts_and_recalculation(self):
        t=self.task(); f=t['fields']; f['data']='CSV за 6 месяцев'
        updated=self.task(id=t['id'],revision=t['revision'],fields=f)
        self.assertEqual(updated['score'],30)
        with self.assertRaises(ValueError): self.task(id=t['id'],revision=t['revision'],fields=f)
        with self.assertRaises(ValueError): self.task(id=t['id'],revision=updated['revision'],confirmed=False,published=False)
    def test_ai_questions_and_no_fabrication(self):
        result=server.ai_questions({'draft':'Нужно сократить списания выпечки.','topic':'Ритейл'})
        self.assertGreaterEqual(len(result['questions']),3)
        self.assertEqual(result['fields']['data'],'')
        self.assertEqual(result['fields']['context'],'Нужно сократить списания выпечки.')
        self.assertIn('продаж',next(q['question'] for q in result['questions'] if q['field']=='data'))
        full=server.ai_questions({'draft':'Все поля уже заполнены.','fields':{f:'Описание поля' for f in server.FIELDS}})
        self.assertGreaterEqual(len(full['questions']),3)
    def test_malformed_ai_output(self):
        for invalid in [None,{}, {'questions':[]}, {'questions':[{'field':'x','question':'Случайный вопрос'}]*3,'fields':{}}]:
            with self.assertRaises(ValueError):server.validate_ai_result(invalid,{})
        r=server.ai_questions({'draft':'Задача для проверки данных.'})
        r['fields']['data']='Выдуманные данные'
        with self.assertRaises(ValueError):server.validate_ai_result(r,{})
    def test_validation(self):
        with self.assertRaises(ValueError):self.task(fields={'title':'a'})
        with self.assertRaises(ValueError):self.task(role='student')
        with self.assertRaises(ValueError):server.ai_questions({'draft':'a'})
        with self.assertRaises(ValueError):server.mutate('/api/proposals',dict(role='student',task_id='t5',team_id='u1',idea='Идея решения',plan='План работ',duration='Неделя',link='javascript:alert(1)'))
        self.assertFalse(server.url_ok('https://user:password@example.com'))
    def test_persistence(self):
        t=self.task()
        server.init_db()
        with server.connect() as c:self.assertIsNotNone(c.execute('SELECT * FROM tasks WHERE id=?',(t['id'],)).fetchone())

if __name__=='__main__':unittest.main()
