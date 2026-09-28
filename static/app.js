'use strict';
const $ = s => document.querySelector(s);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const e = escapeHTML;
let state, view='catalog', role=localStorage.getItem('sana-role') || 'business', teamId=localStorage.getItem('sana-team') || 'u1', search='', topic='', level='', activeId=null, editor=null, editorStep=1, busy=false;
const DRAFT_KEY = 'sana-editor-draft-v1';
const icons = {grid:'▦', arrow:'↗', plus:'＋', check:'✓', bolt:'✦', file:'▤', team:'◉'};
const statusNames={pending:'На рассмотрении',selected:'Выбрана',rejected:'Отклонена'};
const levelClass = score => score < 40 ? 'draft' : score < 70 ? 'working' : score < 90 ? 'ready' : 'priority';
const taskById = id => state.tasks.find(t=>t.id===id);
const teamById = id => state.teams.find(t=>t.id===id);
const countProposals = id => state.proposals.filter(p=>p.task_id===id).length;
const proposalCount = n => `${n} ${n%100>=11&&n%100<=14?'откликов':n%10===1?'отклик':n%10>=2&&n%10<=4?'отклика':'откликов'}`;
const teamPoints = id => state.milestones.filter(m=>state.proposals.find(p=>p.id===m.proposal_id)?.team_id===id).reduce((a,m)=>a+m.points,0);
async function api(path, body) {
  let r;
  try {
    r = await fetch(path, body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)} : {});
  } catch {
    throw new Error('Нет связи с сервером. Проверьте, что Python запущен, затем повторите действие.');
  }
  let data;
  try { data = await r.json(); } catch { throw new Error('Сервер вернул непонятный ответ. Обновите страницу или повторите позже.'); }
  if(!r.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}
let toastTimer;
function toast(message){ clearTimeout(toastTimer); $('#toast').textContent=message; $('#toast').classList.add('show'); toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),6000); }
async function refresh(){
  state=await api('/api/state');
  if(!['business','student'].includes(role)) role='business';
  if(!state.teams.some(t=>t.id===teamId)) teamId=state.teams[0]?.id;
}
function captureEditor(){
  if(!editor || view!=='editor') return;
  const form=$('#draft-form') || $('#questions-form') || $('#card-form');
  if(!form) return;
  for(const [name,value] of new FormData(form)){
    if(name==='topic') editor.topic=value;
    else if(name==='draft') editor.draft=value;
    else if(Object.hasOwn(editor.fields,name)) editor.fields[name]=value;
  }
}
function saveEditor(){
  if(!editor) return;
  try{
    localStorage.setItem(DRAFT_KEY,JSON.stringify({editor:{...editor,confirmNow:false},step:editorStep}));
    if($('#draft-status')) $('#draft-status').textContent='Черновик сохранён в этом браузере';
  }catch{
    if($('#draft-status')) $('#draft-status').textContent='Автосохранение недоступно. Сохраните карточку на сервере перед выходом.';
  }
}
function readEditor(){
  try{
    const value=JSON.parse(localStorage.getItem(DRAFT_KEY));
    if(!value || ![1,2,3].includes(value.step) || !value.editor || !value.editor.fields || !Array.isArray(value.editor.questions)) return null;
    if(!state.topics.includes(value.editor.topic)) return null;
    if(!Object.keys(state.labels).every(f=>typeof value.editor.fields[f]==='string')) return null;
    if(!value.editor.questions.every(q=>q && Object.hasOwn(state.labels,q.field) && typeof q.question==='string')) return null;
    return value;
  }catch{return null;}
}
function draftBanner(){
  if(role!=='business' || !readEditor()) return '';
  return `<section class="resume-banner"><div><strong>Продолжить незавершённую задачу?</strong><p>Ответы сохранены в этом браузере. Публикация потребует вашего подтверждения.</p></div><button class="secondary" data-action="resume">Продолжить заполнение →</button></section>`;
}
function navItem(id,label,icon,count=''){return `<button class="nav-item ${view===id?'active':''}" data-action="nav" data-view="${id}"><span>${icon}</span>${label}${count!==''?`<b>${count}</b>`:''}</button>`;}
function shell(content){
$('#app').innerHTML=`
<aside class="sidebar">

  <button
    class="sidebar-toggle"
    id="sidebarToggle"
    type="button"
    aria-label="Скрыть меню"
  >‹</button>

  <a class="brand" href="#" data-action="nav" data-view="catalog">
    <span class="brand-mark">B</span>
    <span>BizBridge AI</span>
  </a>

  <nav>
    ${navItem('catalog','Каталог задач','▦',state.tasks.filter(t=>t.published).length)}
    ${navItem('workspace',role==='business'?'Мои задачи':'Мои отклики','▤')}
    ${navItem('teams','Команды','◉')}
    ${navItem('guide','Как это работает','✦')}
  </nav>

  <div class="side-note">
    <span class="spark">✦</span>
    <strong>Большие решения<br>начинаются с вопроса.</strong>
    <p>Помогаем бизнесу и студентам найти общий язык.</p>
    <span class="note-line"></span>
  </div>

</aside>

<div class="main-shell">

  <header class="topbar">


    <div class="identity">

      <span class="demo-label">ДЕМО-РОЛЬ</span>

      <select id="role" aria-label="Демо-роль">
        <option value="business" ${role==='business'?'selected':''}>
          Бизнес
        </option>

        <option value="student" ${role==='student'?'selected':''}>
          Студент
        </option>
      </select>

      ${role==='student'
        ? `<select id="team-select" aria-label="Команда">
            ${state.teams.map(t=>`
              <option
                value="${t.id}"
                ${t.id===teamId?'selected':''}
              >
                ${e(t.name)}
              </option>
            `).join('')}
          </select>`
        : ''
      }

      <span class="avatar">
        ${role==='business'?'Б':'С'}
      </span>

    </div>

  </header>

  <main>
    ${content}
  </main>

<footer class="contact-footer">
  <span>DSA QYZPU</span>
  <span class="footer-divider">|</span>
  <span>dsa.qyzpu@gmail.com</span>
  <span class="footer-divider">|</span>
  <span>+7 707 077 07 06</span>
</footer>

</div>`;
}
function pageHead(kicker,title,description,action=''){return `<div class="page-head"><div><div class="eyebrow">${kicker}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;}
function badge(t){return `<span class="badge ${levelClass(t.score)}"><i></i>${t.level}</span>`;}
function card(t,index){return `<article class="task-card"><div class="card-top"><span class="topic-tag">${e(t.topic)}</span><span class="card-number">${String(index+1).padStart(2,'0')}</span></div><h3><button class="title-link" data-action="detail" data-id="${t.id}">${e(t.fields.title)}</button></h3><p class="card-desc">${e(t.fields.need || t.fields.context || 'Задача требует уточнения.')}</p><div class="score-row">${badge(t)}<span class="score-value">${t.score}<small>/100</small></span></div><div class="progress"><span style="width:${t.score}%"></span></div><div class="card-footer"><span>◉ ${proposalCount(countProposals(t.id))}</span><button class="text-button" data-action="detail" data-id="${t.id}">Подробнее <span>↗</span></button></div></article>`;}
function catalog(){
 const tasks=state.tasks.filter(t=>t.published), ready=tasks.filter(t=>t.score>=70).length;
shell(`${pageHead('ОТКРЫТЫЕ ВОЗМОЖНОСТИ','Настоящие задачи.<br>Ваш следующий шаг.','Находите задачи бизнеса, предлагайте идеи и создавайте решения вместе.',role==='business'?'<button class="primary" data-action="new">＋ Создать задачу</button>':'<button class="primary" data-action="nav" data-view="workspace">Мои отклики ↗</button>')}${draftBanner()}<section class="hero-banner"><div><span class="banner-label">ОТ ИДЕИ К СОТРУДНИЧЕСТВУ</span><h2>Чем яснее задача,<br>тем ближе решение.</h2><p>Уточняйте детали, повышайте рейтинг готовности<br>и находите команду для следующего шага.</p><button class="banner-link" data-action="nav" data-view="guide">Как работает рейтинг <span>↗</span></button></div><div class="orbit-art" aria-hidden="true"><div class="orbit o1"></div><div class="orbit o2"></div><div class="orbit o3"></div><div class="art-star">✳</div><span class="floating-label l1">Идея</span><span class="floating-label l2">Команда</span><span class="floating-label l3">Решение ↗</span></div></section><section class="stats"><div><span>Открытых задач</span><strong>${tasks.length.toString().padStart(2,'0')}<small>в общем каталоге</small></strong></div><div><span>Готовы к работе</span><strong>${ready.toString().padStart(2,'0')}<small>рейтинг от 70 баллов</small></strong></div><div><span>Студенческих команд</span><strong>${state.teams.length.toString().padStart(2,'0')}<small>идеи, навыки, энергия</small></strong></div></section><section class="catalog-section"><div class="section-heading"><h2>Каталог задач <span>${tasks.length}</span></h2><span class="muted">↓ По рейтингу готовности</span></div><div class="filters"><label class="search"><span>⌕</span><input id="search" placeholder="Найти задачу или направление" aria-label="Поиск задач" value="${e(search)}"></label><select id="topic-filter" aria-label="Тема"><option value="">Все направления</option>${state.topics.map(t=>`<option ${topic===t?'selected':''}>${e(t)}</option>`).join('')}</select><select id="level-filter" aria-label="Уровень готовности"><option value="">Любая готовность</option>${['Черновик','Рабочая','Готовая','Приоритетная'].map(t=>`<option ${level===t?'selected':''}>${t}</option>`).join('')}</select></div><div id="cards" class="cards"></div></section>`);
 updateCards();
}
function updateCards(){const list=state.tasks.filter(t=>t.published && (!topic||t.topic===topic) && (!level||t.level===level) && `${t.topic} ${t.fields.title} ${t.fields.context} ${t.fields.need}`.toLowerCase().includes(search.toLowerCase()));$('#cards').innerHTML=list.length?list.map(card).join(''):'<div class="empty">Ничего не найдено. Попробуйте другое направление или запрос.<br><button class="text-button" data-action="clear-filters">Сбросить фильтры</button></div>';}
function ratingPanel(t,preview=false){return `<aside class="panel rating-panel"><div class="eyebrow">${preview?'ПРЕДВАРИТЕЛЬНАЯ ОЦЕНКА':'РЕЙТИНГ ГОТОВНОСТИ'}</div><div class="big-score">${t.score}<span>/100</span></div>${badge(t)}<p class="muted">${preview?'Баллы вступят в силу после вашего подтверждения.':'Баллы за сведения, подтверждённые бизнесом.'}</p><div class="rubric">${t.breakdown.map(b=>`<div><span>${b.points?'✓':'○'} ${e(b.label)}</span><b>${b.points}<small>/${b.max}</small></b></div>`).join('')}</div>${t.missing.length?`<div class="improve"><strong>Следующий шаг</strong><p>Добавьте «${e(t.missing[0].label)}», чтобы получить ещё ${t.missing[0].max} баллов.</p></div>`:'<div class="improve"><strong>Всё готово к старту ✦</strong><p>Все поля рейтинга заполнены.</p></div>'}</aside>`;}
function detail(){
 const t=taskById(activeId);if(!t){view='catalog';return render();}
 const proposals=state.proposals.filter(p=>p.task_id===t.id);
 shell(`<button class="back" data-action="nav" data-view="catalog">← К каталогу</button>${pageHead(e(t.topic),e(t.fields.title),t.published?'Опубликованная задача · открыта для всех команд':'Неопубликованный черновик',role==='business'?`<button class="secondary" data-action="edit" data-id="${t.id}">Редактировать ↗</button>`:'')}<div class="detail-layout"><div><section class="panel fields-view">${Object.entries(state.labels).filter(([f])=>f!=='title').map(([f,label])=>`<div><h3>${e(label)}</h3><p class="${t.fields[f]?'':'missing'}">${e(t.fields[f]||'Пока не указано — можно уточнить у бизнеса.')}</p></div>`).join('')}</section><section class="section-space"><div class="section-heading"><h2>${role==='business'?'Отклики команд':'Предложить решение'} <span>${role==='business'?proposals.length:''}</span></h2></div>${role==='business'?`<p class="muted">Вы можете выбрать несколько команд или не выбрать ни одной.</p>${proposals.length?proposals.map(proposalCard).join(''):'<div class="panel empty">Пока нет откликов. Переключитесь на роль студента и предложите решение.</div>'}`:t.published?proposalForm(t):'<p>Отклики доступны после публикации.</p>'}</section></div>${ratingPanel(t)}</div>`);
}
function proposalForm(t){return `<form id="proposal-form" class="panel form-panel"><p class="form-intro">Отклик от команды <strong>${e(teamById(teamId).name)}</strong></p><label>Идея решения<textarea name="idea" required minlength="3" maxlength="4000" placeholder="Как вы предлагаете решить задачу?"></textarea></label><label>План работы<textarea name="plan" required minlength="3" maxlength="4000" placeholder="Основные этапы и ожидаемый результат"></textarea></label><div class="form-two"><label>Срок<input name="duration" required minlength="3" maxlength="200" placeholder="Например, 3 недели"></label><label>Ссылка на прототип<input name="link" type="url" required maxlength="2000" placeholder="https://…"></label></div><button class="primary" type="submit">Отправить предложение ↗</button><small class="muted">Рейтинг задачи не ограничивает подачу отклика.</small></form>`;}
function proposalCard(p){
 const team=teamById(p.team_id), milestones=state.milestones.filter(m=>m.proposal_id===p.id), task=taskById(p.task_id);
 return `<article class="panel proposal"><div class="proposal-header"><div class="team-icon">${e(team.name.slice(0,1))}</div><div><h3>${e(team.name)}</h3><small>${e(team.technologies)}</small></div><span class="badge ${p.status==='selected'?'priority':p.status==='rejected'?'draft':'working'}">${statusNames[p.status]}</span></div>${view==='workspace'?`<button class="text-button" data-action="detail" data-id="${task.id}">${e(task.fields.title)} ↗</button>`:''}<h4>Идея</h4><p>${e(p.idea)}</p><h4>План</h4><p>${e(p.plan)}</p><div class="proposal-meta"><span>◷ ${e(p.duration)}</span><a href="${e(p.link)}" target="_blank" rel="noopener noreferrer">Посмотреть прототип ↗</a></div>${role==='business'?`<div class="actions">${p.status!=='selected'?`<button class="primary small" data-action="decision" data-id="${p.id}" data-status="selected">✓ Выбрать команду</button>`:''}${p.status!=='rejected'?`<button class="secondary small" data-action="decision" data-id="${p.id}" data-status="rejected">Отклонить</button>`:''}${p.status!=='pending'?`<button class="text-button" data-action="decision" data-id="${p.id}" data-status="pending">Вернуть на рассмотрение</button>`:''}</div>`:''}${milestones.length?`<div class="milestones"><h4>Подтверждённый прогресс</h4>${milestones.map(m=>`<div class="milestone"><div><strong>${e(m.name)}</strong><a href="${e(m.evidence)}" target="_blank" rel="noopener noreferrer">Результат этапа ↗</a></div>${m.status==='confirmed'?'<span class="badge priority">✓ +20 баллов</span>':role==='business'&&p.status==='selected'?`<button class="secondary small" data-action="confirm-stage" data-id="${m.id}">Подтвердить +20</button>`:'<span class="muted">Ожидает подтверждения</span>'}</div>`).join('')}</div>`:''}${role==='student'&&p.status==='selected'&&p.team_id===teamId?`<form class="stage-form" data-proposal="${p.id}"><h4>Отправить выполненный этап</h4><label>Название этапа<input name="name" required minlength="3" maxlength="200" placeholder="Например, проверка данных"></label><label>Ссылка на результат<input type="url" name="evidence" required maxlength="4000" placeholder="https://…"></label><button class="secondary small">Отправить на подтверждение</button></form>`:''}</article>`;
}
function previewRating(fields){const unusable=['нет','n/a','тест','потом','не знаю','???','...','уточним','неизвестно'];const breakdown=state.rubric.map(([field,max])=>({field,label:state.labels[field],max,points:fields[field]?.trim().length>=3&&!unusable.includes(fields[field].trim().toLowerCase())?max:0}));const score=breakdown.reduce((s,b)=>s+b.points,0);return {score,level:score<40?'Черновик':score<70?'Рабочая':score<90?'Готовая':'Приоритетная',breakdown,missing:breakdown.filter(b=>!b.points)};}
function newEditor(t){editor=t?{...t,fields:{...t.fields},questions:[],confirmNow:false}:{fields:Object.fromEntries(Object.keys(state.labels).map(f=>[f,''])),draft:'',topic:'Образование',questions:[],confirmNow:false};editorStep=t?3:1;view='editor';saveEditor();render();}

function editorPage(){
 const stepNames=['Черновик','Уточнение','Карточка и рейтинг'];
 let body='';
 if(editorStep===1){body=`<div class="panel form-panel"><div class="section-number">01 / ОПИШИТЕ СИТУАЦИЮ</div><h2>С какой задачей вам нужна помощь?</h2><p class="muted">Начните с нескольких предложений. Уточняющие вопросы помогут собрать остальные детали.</p><form id="draft-form"><label>Направление<select name="topic">${state.topics.map(t=>`<option ${editor.topic===t?'selected':''}>${e(t)}</option>`).join('')}</select></label><label>Черновик задачи<textarea name="draft" class="large-textarea" required minlength="10" maxlength="4000" placeholder="Например: у нашей кофейни остаётся много выпечки. Хотим лучше планировать закупки.">${e(editor.draft)}</textarea></label><div class="actions"><button class="primary" type="submit">Уточнить задачу ✦</button><button class="text-button" type="button" data-action="sample">Подставить демо-пример</button></div></form><div class="ai-note"><span>✦</span><p><b>Локальный AI-режим · заглушка</b>Вопросы подбираются по незаполненным полям и направлению. Модель не подключена; новые факты не добавляются.</p></div></div>`;}
if(editorStep===2){body=`
<form id="questions-form" class="panel form-panel">

<div class="section-number">
  02 / УТОЧНЯЮЩИЕ ВОПРОСЫ
</div>

<h2>Добавим важные детали</h2>

<p class="muted">
  Можно оставить поле пустым. Недостающие сведения останутся видны в рейтинге.
</p>

${editor.questions.map((q,i)=>{  const rubricItem = state.rubric.find(([field]) => field === q.field);
  const points = rubricItem ? rubricItem[1] : 0;

  return `<label class="question-card">
    <span class="question-head">
      <span>
        <b class="question-num">${String(i+1).padStart(2,'0')}</b>
        ${e(state.labels[q.field])}
      </span>
      <strong>Вес: ${points} баллов</strong>
    </span>

    <span class="question-text">${e(q.question)}</span>

    <textarea
      name="${q.field}"
      maxlength="4000"
      placeholder="Ваш ответ…"
    >${e(editor.fields[q.field])}</textarea>
  </label>`;
}).join('')}<div class="actions"><button class="primary" type="submit">Собрать карточку →</button><button class="text-button" type="button" data-action="sample-answers">Заполнить демо-ответами</button></div><details><summary>Промпт и формат AI</summary><pre>${e(state.aiPrompt)}</pre><p class="muted">Ответ валидируется на сервере: минимум 3 вопроса, допустимые поля, отсутствие новых фактов. При ошибке ответы пользователя сохраняются в форме.</p></details></form>`;}
 if(editorStep===3){body=`<div class="detail-layout"><form id="card-form" class="panel form-panel"><div class="section-number">03 / ПРОВЕРЬТЕ И ПОДТВЕРДИТЕ</div><h2>Ваша задача обрела форму</h2><p class="muted">Проверьте каждое поле. Пропуски допустимы даже при публикации.</p><label>Направление<select name="topic">${state.topics.map(t=>`<option ${editor.topic===t?'selected':''}>${e(t)}</option>`).join('')}</select></label>${Object.entries(state.labels).map(([f,label])=>`<label>${e(label)}${f==='title'?' *':''}${f==='title'?`<input name="${f}" required minlength="3" maxlength="160" value="${e(editor.fields[f])}" placeholder="Короткое и понятное название">`:`<textarea name="${f}" maxlength="4000" placeholder="Пока не указано">${e(editor.fields[f])}</textarea>`}</label>`).join('')}<label class="confirm-label"><input id="confirmation" type="checkbox" ${editor.confirmNow?'checked':''}> <span>Я проверил(а) и подтверждаю сведения карточки. При публикации они будут доступны всем командам.</span></label><div class="actions"><button class="primary" type="submit" name="intent" value="publish">${editor.published?'Подтвердить изменения':'Подтвердить и опубликовать'} ↗</button>${!editor.published?'<button class="secondary" type="submit" name="intent" value="save">Сохранить черновик</button>':''}</div></form><div id="editor-rating">${ratingPanel(previewRating(editor.fields),true)}</div></div>`;}
 shell(`<button class="back" data-action="nav" data-view="catalog">← К каталогу</button>${pageHead('КОНСТРУКТОР ЗАДАЧИ','От мысли к понятной задаче.','Сначала смысл. Затем детали. И команда, готовая взяться за дело.')}<div class="draft-toolbar"><span id="draft-status" role="status">Черновик сохраняется в этом браузере</span>${editorStep>1?'<button class="text-button" data-action="previous-step">← Предыдущий шаг</button>':''}</div><div class="steps">${stepNames.map((name,i)=>`<div class="step ${editorStep===i+1?'current':editorStep>i+1?'done':''}"><span>${editorStep>i+1?'✓':i+1}</span>${name}</div>`).join('')}</div>${body}`);
}
function teamProgressCard(teamId) {
  const team = teamById(teamId);
  if (!team) return '';

  const proposals = state.proposals.filter(
    p => p.team_id === teamId
  );

  const selected = proposals.some(
    p => p.status === 'selected'
  );

  const proposalIds = proposals.map(p => p.id);

  const confirmedStages = state.milestones.filter(
    m =>
      proposalIds.includes(m.proposal_id) &&
      m.status === 'confirmed'
  );

  // Только баллы подтверждённых этапов: одинаково с каталогом команд.
  const xp = confirmedStages.reduce((sum, stage) => sum + stage.points, 0);

  const level = xp >= 200 ? 4 : xp >= 100 ? 3 : xp >= 50 ? 2 : 1;

  const levelName =
    level === 4 ? 'Innovation Maker' :
    level === 3 ? 'Solution Builder' :
    level === 2 ? 'Problem Solver' :
    'Explorer';

  const nextLevel =
    level === 4 ? 300 :
    level === 3 ? 200 :
    level === 2 ? 100 : 50;

  const levelStart =
    level === 4 ? 200 :
    level === 3 ? 100 :
    level === 2 ? 50 : 0;

  const progress = Math.min(
    100,
    level === 4 ? 100 : ((xp - levelStart) / (nextLevel - levelStart)) * 100
  );

  const firstStageDone = confirmedStages.length > 0;

  return `
    <section class="team-xp-card">

      <div class="team-xp-header">

        <div>
          <span class="team-xp-eyebrow">ПРОГРЕСС КОМАНДЫ</span>

          <h2>${e(team.name)}</h2>

          <p class="team-xp-level">
            Уровень ${level}
            <span>·</span>
            ${levelName}
          </p>
        </div>

        <div class="team-xp-score">
          <strong>${xp}</strong>
          <span>XP</span>
        </div>

      </div>

      <div class="team-xp-progress">
        <span style="width:${progress}%"></span>
      </div>

      <div class="team-xp-progress-info">
        <span>${xp} XP</span>
        <span>${level === 4 ? 'Максимальный уровень' : `${nextLevel - xp} XP до следующего уровня`}</span>
      </div>

      <div class="team-xp-goals">

        <div class="team-xp-goal ${selected ? 'done' : ''}">
          <div class="team-xp-check">${selected ? '✓' : '○'}</div>

          <div class="team-xp-goal-text">
            <strong>Команда выбрана</strong>
            <small>
              ${selected
                ? 'Бизнес подтвердил сотрудничество'
                : 'Ожидает решения бизнеса'}
            </small>
          </div>
        </div>

        <div class="team-xp-goal ${firstStageDone ? 'done' : ''}">
          <div class="team-xp-check">${firstStageDone ? '✓' : '○'}</div>

          <div class="team-xp-goal-text">
            <strong>Первый этап выполнен</strong>
            <small>
              ${firstStageDone
                ? 'Результат подтверждён бизнесом'
                : 'Ожидает выполнения'}
            </small>
          </div>

          ${firstStageDone
            ? '<span class="team-xp-reward">+20 XP</span>'
            : ''}
        </div>


      </div>

    </section>
  `;
}
function workspace(){
 if(role==='business'){
 shell(`${pageHead('ЛИЧНЫЙ КАБИНЕТ · ДЕМО','Задачи и новые возможности.','Все задачи демо-пространства доступны представителю бизнеса.','<button class="primary" data-action="new">＋ Создать задачу</button>')}<div class="workspace-list">${state.tasks.map(t=>`<button class="workspace-row" data-action="detail" data-id="${t.id}"><div><span class="topic-tag">${e(t.topic)}</span><h3>${e(t.fields.title)}</h3><p>${t.published?'Опубликовано':'Не опубликовано'} · ${proposalCount(countProposals(t.id))} · ${state.proposals.filter(p=>p.task_id===t.id&&p.status==='selected').length} команд выбрано</p></div><div>${badge(t)}<strong>${t.score}<small>/100</small></strong><span>↗</span></div></button>`).join('')}</div>`);
 }else{

  const ps = state.proposals.filter(
    p => p.team_id === teamId
  );

  shell(`
    ${pageHead(
      'КАБИНЕТ КОМАНДЫ',
      e(teamById(teamId).name),
      `${proposalCount(ps.length)} · ${teamPoints(teamId)} баллов за подтверждённые этапы`
    )}

    ${teamProgressCard(teamId)}

    <div class="narrow">
      ${
        ps.length
          ? ps.map(proposalCard).join('')
          : `
            <div class="panel empty">
              Здесь появятся ваши отклики.<br>
              <button
                class="text-button"
                data-action="nav"
                data-view="catalog">
                Перейти в каталог ↗
              </button>
            </div>
          `
      }
    </div>
  `);

}
}
function teams(){shell(`${pageHead('СООБЩЕСТВО','Разные навыки. Общая цель.','Пять демонстрационных команд. Баллы начисляются только после подтверждения выполненного этапа бизнесом.')}<div class="cards">${state.teams.map(t=>`<article class="panel team-card"><div class="team-icon">${e(t.name[0])}</div><h2>${e(t.name)}</h2><p>${e(t.interests)}</p><div class="team-detail"><span>Навыки</span><strong>${e(t.skills)}</strong><span>Технологии</span><strong>${e(t.technologies)}</strong></div><div class="team-points"><b>${teamPoints(t.id)}</b> баллов за прогресс</div></article>`).join('')}</div>`);}
function guide(){shell(`${pageHead('ПОНЯТНЫЕ ПРАВИЛА','Больше ясности — выше рейтинг.','Геймификация помогает бизнесу подготовить задачу к совместной работе.')}<div class="detail-layout"><div><section class="panel guide"><h2>Исходные данные для проверки</h2><p>В учебном наборе 5 черновиков разной полноты, 5 карточек с рейтингом, 5 профилей команд и 5 разных откликов. Все данные синтетические.</p><a class="secondary" href="/api/demo-data" download="ai-sana-demo-data.json">Скачать JSON-набор ↓</a><h2 class="section-space">От черновика до результата</h2>${['Опишите проблему своими словами.','Ответьте минимум на три предложенных вопроса или оставьте неизвестное пустым.','Отредактируйте и подтвердите карточку.','Опубликуйте задачу: каталог сортируется по рейтингу.','Команды отправляют идеи, планы, сроки и прототипы.','Бизнес вручную выбирает одну, несколько или ни одной команды.','Выбранная команда отправляет результат этапа; бизнес подтверждает его и начисляет 20 баллов.'].map((s,i)=>`<div class="guide-step"><b>${i+1}</b><p>${s}</p></div>`).join('')}<h3>Четыре уровня готовности</h3><p>0–39 — черновик · 40–69 — рабочая · 70–89 — готовая · 90–100 — приоритетная.</p><p>Низкий рейтинг не скрывает опубликованную задачу и не блокирует отклики. Рейтинг оценивает полноту сведений, а не репутацию компании.</p><h3>Как считаются баллы</h3><p>Начисляется полный вес за каждое содержательно заполненное и подтверждённое поле. Контекст и потребность дают по 10 баллов; контакт и формат взаимодействия — по 5. Пустые поля и ответы «не знаю», «уточним», «нет» не получают баллов. Автоматическая проверка смысла не выполняется: бизнес отвечает за достоверность.</p><h3>Демонстрационный режим</h3><p>Роли переключаются без регистрации; разграничение владельцев и авторизация не реализованы. Данные сохраняются на этом сервере в SQLite. Локальная AI-заглушка задаёт вопросы по пропускам и переносит ответы дословно. Ссылки example.com в тестовых откликах — примеры.</p><details><summary>Посмотреть AI-промпт</summary><pre>${e(state.aiPrompt)}</pre></details></section></div>${ratingPanel(previewRating(Object.fromEntries(Object.keys(state.labels).map(f=>[f,'Заполненное поле']))))}</div>`);}
function render(){({catalog,detail,editor:editorPage,workspace,teams,guide}[view]||catalog)();}
const demoAnswers={context:'В кофейне каждый вечер остаётся непроданная выпечка. Закупки планируются вручную.',need:'Снизить списания и рассчитывать объём закупок на следующий день.',users:'Управляющий кофейней и сотрудник, оформляющий закупки.',data:'Обезличенные CSV продаж и списаний за 6 месяцев, по дате и категории товара.',constraints:'Три недели; локальный прототип; без подключения к кассе и персональных данных.',result:'Панель с прогнозом спроса по категориям на следующий день.',criteria:'На отложенной выборке MAE ниже среднего за последние 7 дней; показать сравнение на графике.',contact:'coffee@example.com',interaction:'Созвон каждый вторник; ответ на вопросы в течение двух рабочих дней.'};
async function action(el){
 const a=el.dataset.action,id=el.dataset.id;
 if(view==='editor'){captureEditor();saveEditor();}
 if(a==='nav'){view=el.dataset.view;render();}
 if(a==='detail'){activeId=id;view='detail';render();}
 if(a==='new'){const draft=readEditor();if(draft){editor=draft.editor;editor.confirmNow=false;editorStep=draft.step;view='editor';render();}else newEditor();}
 if(a==='resume'){const draft=readEditor();if(draft){editor=draft.editor;editor.confirmNow=false;editorStep=draft.step;view='editor';render();}}
 if(a==='previous-step'){captureEditor();editorStep=Math.max(1,editorStep-1);editor.confirmNow=false;saveEditor();render();}
 if(a==='edit')newEditor(taskById(id));
 if(a==='clear-filters'){search='';topic='';level='';catalog();}
 if(a==='sample'){const f=$('#draft-form');f.elements.draft.value='У нашей кофейни остаётся много выпечки. Хотим лучше планировать закупки.';f.elements.topic.value='Ритейл';captureEditor();saveEditor();}
 if(a==='sample-answers'){const f=$('#questions-form');editor.questions.forEach(q=>f.elements[q.field].value=demoAnswers[q.field]);captureEditor();saveEditor();toast('Демонстрационные ответы добавлены. Проверьте их перед продолжением.');}
 if(a==='decision'){await api('/api/decision',{role,id,status:el.dataset.status});await refresh();render();toast('Решение сохранено');}
 if(a==='confirm-stage'){await api('/api/milestones/confirm',{role,id});await refresh();render();toast('Этап подтверждён · команде начислено 20 баллов');}
 if(['nav','detail','new','edit'].includes(a))window.scrollTo({top:0});
}
document.addEventListener('click',async event=>{
 const el=event.target.closest('[data-action]');if(!el)return;event.preventDefault();if(busy)return;busy=true;el.disabled=true;try{await action(el);}catch(err){toast(err.message);}finally{busy=false;el.disabled=false;}
});
document.addEventListener('change',event=>{
 if(event.target.id==='role'){if(view==='editor'){captureEditor();saveEditor();}role=event.target.value;localStorage.setItem('sana-role',role);if(view==='editor')view='catalog';render();}
 if(event.target.id==='team-select'){teamId=event.target.value;localStorage.setItem('sana-team',teamId);render();}
 if(event.target.id==='topic-filter'){topic=event.target.value;updateCards();}
 if(event.target.id==='level-filter'){level=event.target.value;updateCards();}
 if(event.target.id==='confirmation')editor.confirmNow=event.target.checked;
 if(view==='editor'){captureEditor();saveEditor();}
 if(event.target.closest('#card-form') && event.target.name==='topic'){editor.topic=event.target.value;editor.confirmNow=false;$('#confirmation').checked=false;}
});
document.addEventListener('input',event=>{
 if(event.target.id==='search'){search=event.target.value;updateCards();}
 if(view==='editor'){captureEditor();saveEditor();}
 if(event.target.closest('#card-form')&&Object.hasOwn(editor.fields,event.target.name)){editor.fields[event.target.name]=event.target.value;editor.confirmNow=false;$('#confirmation').checked=false;$('#editor-rating').innerHTML=ratingPanel(previewRating(editor.fields),true);}
});
document.addEventListener('submit',async event=>{
 event.preventDefault();if(busy)return;busy=true;const f=event.target,button=event.submitter || f.querySelector('button[type=submit],button:not([type])');if(button)button.disabled=true;const values=Object.fromEntries(new FormData(f));
 try{
 if(f.id==='draft-form'){
 editor.draft=values.draft;editor.topic=values.topic;
 if(!editor.id) editor.fields.context=editor.draft;
 saveEditor();
 const result=await api('/api/ai',{draft:editor.draft,topic:editor.topic,fields:editor.fields});editor.fields=result.fields;editor.questions=result.questions;editorStep=2;saveEditor();render();
 }else if(f.id==='questions-form'){
 Object.assign(editor.fields,values);editorStep=3;saveEditor();render();
 }else if(f.id==='card-form'){
 const published=button?.value==='publish';const confirmed=$('#confirmation').checked;
 if(published&&!confirmed)throw new Error('Подтвердите сведения карточки перед публикацией.');
 const fields=Object.fromEntries(Object.keys(state.labels).map(key=>[key,values[key]||'']));
 const result=await api('/api/tasks',{role,id:editor.id,revision:editor.revision,topic:values.topic,draft:editor.draft,fields,confirmed,published});
 editor={...editor,...result,confirmNow:false};
 try{localStorage.removeItem(DRAFT_KEY);}catch{}
 await refresh();activeId=result.id;view='detail';editor=null;render();toast(published?`Карточка подтверждена · ${result.score} из 100 баллов`:'Черновик сохранён');
 }else if(f.id==='proposal-form'){
 await api('/api/proposals',{role,task_id:activeId,team_id:teamId,...values});await refresh();view='workspace';render();toast('Предложение отправлено бизнесу');
 }else if(f.classList.contains('stage-form')){
 await api('/api/milestones',{role,proposal_id:f.dataset.proposal,team_id:teamId,...values});await refresh();render();toast('Результат этапа отправлен на подтверждение');
 }
 window.scrollTo({top:0});
 }catch(err){toast(err.message);}finally{busy=false;if(button)button.disabled=false;}
});
refresh().then(render).catch(err=>{$('#app').innerHTML=`<div class="loading"><h1>Не удалось загрузить приложение</h1><p>${e(err.message)}</p><p>Убедитесь, что server.py запущен, и обновите страницу.</p></div>`;});
// Открытие / закрытие бокового меню
document.addEventListener('click', (event) => {
  const toggle = event.target.closest('#sidebarToggle');

  if (!toggle) return;

  document.body.classList.toggle('sidebar-collapsed');
});