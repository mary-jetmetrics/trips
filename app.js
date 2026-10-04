'use strict';
// Каталог поездок. Оболочка публичная, данные — в закрытом репозитории mary-jetmetrics/trips-data,
// доступ по ключу (fine-grained token), который вводится один раз на устройстве.
const OWNER = 'mary-jetmetrics', REPO = 'trips-data', BRANCH = 'main';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* без хранилища — войдёт заново */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* нечего удалять */ } },
};
let TOKEN = LS.get('trips-token');
let CAN_WRITE = LS.get('trips-ro') !== '1';
let INDEX = [];
const TRIPS = {}, SHA = {}, BLOBS = {};
let TRIP = null, EXP = [], nights = null, total = 0;
const state = { tab: 'Траты', group: null, sort: 'amount', dir: -1 };
const root = document.getElementById('root');

/* ---------- общее ---------- */
const MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const fmt = n => new Intl.NumberFormat('ru-RU').format(Math.round(n)).replace(/ /g, ' ') + ' ₽';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return (m > 10 && m < 20) ? c : k === 1 ? a : (k >= 2 && k <= 4) ? b : c; };
const b64enc = str => { const bytes = new TextEncoder().encode(str); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const b64dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
const today = () => new Date(new Date().toDateString());
const nightsOf = t => t.dates ? Math.round((new Date(t.dates.end) - new Date(t.dates.start)) / 864e5) : null;
const ended = t => t.dates && new Date(t.dates.end) < today();
function when(t) {
  if (!t.dates) { const [y, m] = t.month.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; }
  const a = new Date(t.dates.start), b = new Date(t.dates.end), n = nightsOf(t);
  const d = a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${MON_GEN[b.getMonth()]}` : `${a.getDate()} ${MON_GEN[a.getMonth()]} – ${b.getDate()} ${MON_GEN[b.getMonth()]}`;
  return `${d} ${b.getFullYear()} · ${n} ${plural(n, 'ночь', 'ночи', 'ночей')}`;
}
const WAVE = '<svg class="ls-wave" viewBox="0 0 190 8" aria-hidden="true"><path d="M1 4 Q 6 0 11 4 T 21 4 T 31 4 T 41 4 T 51 4 T 61 4 T 71 4 T 81 4 T 91 4 T 101 4 T 111 4 T 121 4 T 131 4 T 141 4 T 151 4 T 161 4 T 171 4 T 181 4"/></svg>';
const UMBRELLA = '<svg class="ls-umbrella" width="40" height="40" viewBox="0 0 46 46" aria-hidden="true"><g transform="rotate(-14 23 23)"><path class="canopy" d="M8 20 A15 11 0 0 1 38 20 Z"/><path class="stripe" d="M23 20 L8 20 A15 11 0 0 1 12.5 12.2 Z"/><path class="stripe" d="M23 20 L18 9.3 A15 11 0 0 1 28 9.3 Z"/><path class="stripe" d="M23 20 L33.5 12.2 A15 11 0 0 1 38 20 Z"/><line class="stick" x1="23" y1="20" x2="22" y2="40"/></g></svg>';

/* ---------- GitHub ---------- */
async function gh(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) { const e = new Error('GitHub ответил ' + r.status); e.status = r.status; throw e; }
  return r;
}
async function readJSON(file) { const j = await (await gh(`/contents/${file}?ref=${BRANCH}`)).json(); SHA[file] = j.sha; return JSON.parse(b64dec(j.content)); }
async function writeFile(file, base64, message) {
  const body = { message, content: base64, branch: BRANCH }; if (SHA[file]) body.sha = SHA[file];
  const j = await (await gh(`/contents/${file}`, { method: 'PUT', body: JSON.stringify(body) })).json(); SHA[file] = j.content.sha;
}
async function deleteFile(file, message) {
  if (!SHA[file]) SHA[file] = (await (await gh(`/contents/${file}?ref=${BRANCH}`)).json()).sha;
  await gh(`/contents/${file}`, { method: 'DELETE', body: JSON.stringify({ message, sha: SHA[file], branch: BRANCH }) }); delete SHA[file];
}
async function blobURL(file) {
  if (!BLOBS[file]) BLOBS[file] = URL.createObjectURL(await (await gh(`/contents/${file}?ref=${BRANCH}`, { headers: { Accept: 'application/vnd.github.raw' } })).blob());
  return BLOBS[file];
}

/* ---------- сохранение: правка → через секунду карточка уходит в репозиторий ---------- */
let saveTimer = null, saving = false, dirty = false;
function setSave(text, err) { const el = document.getElementById('save'); if (el) { el.textContent = text; el.classList.toggle('err', !!err); } }
function changed() { if (!CAN_WRITE) return; dirty = true; setSave('Сохраняю…'); clearTimeout(saveTimer); saveTimer = setTimeout(flush, 1000); }
async function flush() {
  if (saving) { saveTimer = setTimeout(flush, 700); return; }
  if (!dirty || !TRIP) return;
  saving = true; dirty = false;
  const t = TRIP, file = `trips/${t.id}.json`;
  try {
    await writeFile(file, b64enc(JSON.stringify(t, null, 1)), `«${t.title}»: правки из приложения`);
    setSave('Сохранено');
  } catch (e) {
    if (e.status === 403) { CAN_WRITE = false; document.body.classList.add('ro'); setSave('У этого ключа только просмотр — правки не сохраняются', true); }
    else if (e.status === 409 || e.status === 422) {
      try { TRIPS[t.id] = await readJSON(file); if (TRIP && TRIP.id === t.id) { setTrip(t.id); render(); } setSave('Подтянула правки с другого устройства — повтори последнее действие', true); }
      catch (e2) { dirty = true; setSave('Не сохранилось, проверь интернет', true); }
    } else { dirty = true; setSave('Не сохранилось, повторю через 10 секунд', true); saveTimer = setTimeout(flush, 10000); }
  } finally { saving = false; }
}
window.addEventListener('beforeunload', e => { if (dirty || saving) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- вход и загрузка ---------- */
function loginView(msg) {
  root.innerHTML = `<header class="head"><h1 class="ls-title">Поездки</h1>${WAVE}</header>
  <form class="login" id="login">
    <p style="margin:0">Вставь ключ доступа — один раз на этом устройстве. Ключ хранится только здесь, в браузере.</p>
    ${msg ? `<p class="cap" style="margin:0;color:var(--bad)">${esc(msg)}</p>` : ''}
    <label class="cap" for="tok">Ключ (начинается с github_pat_)</label>
    <input id="tok" autocomplete="off" spellcheck="false" placeholder="github_pat_…">
    <label class="cap" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="ro"> Только смотреть</label>
    <button class="ls-btn ls-btn-main" type="submit">Войти</button>
  </form>`;
  document.getElementById('login').addEventListener('submit', e => {
    e.preventDefault();
    const v = document.getElementById('tok').value.trim(); if (!v) return;
    TOKEN = v; LS.set('trips-token', v);
    CAN_WRITE = !document.getElementById('ro').checked; LS.set('trips-ro', CAN_WRITE ? '0' : '1');
    boot();
  });
}
async function boot() {
  if (!TOKEN) return loginView();
  root.innerHTML = '<p class="cap">Загружаю поездки…</p>';
  try {
    INDEX = await readJSON('index.json');
    await Promise.all(INDEX.map(async t => { TRIPS[t.id] = await readJSON(`trips/${t.id}.json`); }));
  } catch (e) {
    if ([401, 403, 404].includes(e.status)) { LS.del('trips-token'); TOKEN = null; return loginView('Ключ не подошёл. Проверь, что он для репозитория trips-data и не просрочен.'); }
    root.innerHTML = `<p class="cap">Не получилось загрузить поездки: ${esc(e.message)}. Проверь интернет и обнови страницу.</p>`; return;
  }
  document.body.classList.toggle('ro', !CAN_WRITE);
  window.addEventListener('hashchange', route);
  route();
}
function route() {
  const m = location.hash.match(/^#\/trip\/([^/]+)(?:\/(.+))?/);
  if (m && TRIPS[m[1]]) {
    if (!TRIP || TRIP.id !== m[1]) { setTrip(m[1]); state.group = null; }
    state.tab = m[2] ? decodeURIComponent(m[2]) : (ended(TRIP) ? 'Траты' : 'Вещи');
    tripView();
  } else catalogView();
  window.scrollTo(0, 0);
}

/* ---------- каталог ---------- */
function catalogView() {
  TRIP = null;
  root.innerHTML = `<header class="head"><div class="topbar"><h1 class="ls-title">Поездки</h1><button class="back" id="logout">Выйти</button></div>${WAVE}
    <p class="cap" style="margin:0">${INDEX.length} ${plural(INDEX.length, 'поездка', 'поездки', 'поездок')}${CAN_WRITE ? '' : ' · только просмотр'}</p></header>
    <div class="ls-block trips">${INDEX.map(t => `<button class="trip-row" data-go="${esc(t.id)}"><b>${esc(t.title)}</b><span class="cap">${esc(when(TRIPS[t.id]))}</span></button>`).join('')}</div>
    <p class="cap">Каталог оформим позже, когда соберём обзор поездки.</p>`;
}

/* ---------- карточка поездки ---------- */
const TABS = ['Обзор', 'Вещи', 'Места', 'Еда', 'Траты', 'Фото'];
function setTrip(id) {
  TRIP = TRIPS[id];
  TRIP.packing = TRIP.packing || { sections: [] }; TRIP.places = TRIP.places || []; TRIP.food = TRIP.food || []; TRIP.photos = TRIP.photos || []; TRIP.notes = TRIP.notes || [];
  EXP = TRIP.expenses = TRIP.expenses || [];
  nights = nightsOf(TRIP);
  total = EXP.reduce((s, e) => s + e.amount, 0);
}
function tripView() {
  root.innerHTML = `<header class="head">
      <div class="topbar"><button class="back" data-go="">← Все поездки</button><span class="save" id="save">${CAN_WRITE ? '' : 'только просмотр'}</span></div>
      <h1 class="ls-title">${esc(TRIP.title)}</h1>${WAVE}<p class="cap" style="margin:0">${esc(when(TRIP))}</p></header>
    <nav class="tabs" role="tablist" id="tabs">${TABS.map(t => `<button role="tab" data-tab="${t}" aria-selected="${t === state.tab}">${t}</button>`).join('')}</nav>
    <main id="pane"></main>`;
  render();
}
function render() {
  const pane = document.getElementById('pane'); if (!pane) return;
  document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  const views = { 'Обзор': overviewTab, 'Вещи': packTab, 'Места': () => listTab('places'), 'Еда': () => listTab('food'), 'Траты': spend, 'Фото': () => photosTab() + lightbox() };
  pane.innerHTML = (views[state.tab] || spend)();
  if (state.tab === 'Фото') hydratePhotos();
}

/* ---------- Обзор (пока заметки) ---------- */
function overviewTab() {
  let html = '', head = null;
  TRIP.notes.forEach(n => { if (n.section && n.section !== head) { head = n.section; html += `<h3>${esc(head)}</h3>`; } html += `<p>${esc(n.text).replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')}</p>`; });
  return `<div style="display:grid;gap:var(--space-6)">
    <p class="cap later" style="padding:0">Обзор поездки соберём позже, из остальных вкладок.</p>
    <section class="section"><h2 class="ls-h">Заметки</h2><div class="ls-block notes">${html || '<p class="cap">Пока без заметок.</p>'}
      <label class="add w-only"><span aria-hidden="true">+</span><input data-note placeholder="добавить заметку" aria-label="Добавить заметку"></label></div></section>
  </div>`;
}

/* ---------- Траты ---------- */
const CAT = (key, tag, color) => ({ key, tag, color, cats: [key] });
const GRAY = ['ls-tag-gray', 'var(--gray)'];
const GROUPS = [
  CAT('Жильё', '', 'var(--pink)'), CAT('Дорога', 'ls-tag-sky', 'var(--sky)'),
  CAT('Готовая еда', 'ls-tag-lemon', 'var(--lemon)'), CAT('Продукты', 'ls-tag-lemon', 'var(--lemon)'),
  CAT('Такси', 'ls-tag-sand', 'var(--sand)'), CAT('Транспорт', 'ls-tag-sand', 'var(--sand)'),
  CAT('Развлечения и спорт', 'ls-tag-lavender', 'var(--lavender)'), CAT('Подарки', 'ls-tag-salad', 'var(--salad)'),
  ...['Здоровье', 'Красота', 'Одежда', 'Другое'].map(k => CAT(k, ...GRAY)),
];
const PREPAID = ['Жильё', 'Дорога'];
const groupOf = c => GROUPS.find(g => g.cats.includes(c)) || GROUPS[GROUPS.length - 1];
const note = e => e.rank ? `${e.rank}-е место среди ресторанов поездки` : (e.note || '');
function summaryOf(t) {
  const tot = t.expenses.reduce((s, e) => s + e.amount, 0), n = nightsOf(t);
  const onSite = t.expenses.filter(e => !PREPAID.includes(e.category)).reduce((s, e) => s + e.amount, 0);
  return { id: t.id, total: tot, perDay: n ? tot / n : null, onSiteDay: n ? onSite / n : null };
}
function spend() {
  if (!EXP.length) return `<div class="ls-block"><div class="ls-empty">${UMBRELLA}<span class="cap">Трат пока нет. После поездки соберу их из Дзенмани.</span></div></div>`;
  const perNight = v => nights ? fmt(v / nights) : '—';
  const groups = GROUPS.map(g => ({ ...g, items: EXP.filter(e => groupOf(e.category).key === g.key) }))
    .map(g => ({ ...g, sum: g.items.reduce((s, e) => s + e.amount, 0) })).filter(g => g.sum > 0).sort((a, b) => b.sum - a.sum);
  const max = groups[0].sum;
  const pct = v => { const p = v / total * 100; return (p < 1 ? p.toFixed(1).replace('.', ',') : Math.round(p)) + '%'; };
  const onSite = EXP.filter(e => !PREPAID.includes(e.category)).reduce((s, e) => s + e.amount, 0);
  const others = Object.values(TRIPS).filter(t => t.id !== TRIP.id && ended(t)).map(summaryOf);
  const compare = (v, key) => {
    if (!ended(TRIP)) return 'поездка ещё не закончилась';
    if (v == null) return 'даты поездки не записаны';
    const o = others.filter(t => t[key] != null);
    if (!o.length) return 'сравнить пока не с чем';
    const avg = o.reduce((s, t) => s + t[key], 0) / o.length, d = Math.round((v / avg - 1) * 100);
    return d === 0 ? `как среднее (${fmt(avg)})` : `<span class="d ${d > 0 ? 'bad' : 'good'}">${d > 0 ? '+' : '−'}${Math.abs(d)}%</span> к среднему (${fmt(avg)})`;
  };
  const catRows = groups.map(g => `<div class="cat pick" role="button" tabindex="0" data-pick="${esc(g.key)}" aria-pressed="${state.group === g.key}">
      <span class="name"><span class="ls-tag ${g.tag}">${esc(g.key)}</span></span>
      <span class="track"><span class="bar" style="--g:${g.color};width:${(g.sum / max * 100).toFixed(1)}%"></span></span>
      <span class="vals narrow-only">${fmt(g.sum)}<span class="cap">${pct(g.sum)} · ${perNight(g.sum)} в сутки</span></span>
      <span class="col wide-only">${fmt(g.sum)}</span><span class="col muted wide-only">${pct(g.sum)}</span><span class="col muted wide-only">${perNight(g.sum)}</span>
    </div>`).join('');
  const rows = EXP.filter(e => !state.group || groupOf(e.category).key === state.group).slice().sort((a, b) => {
    const k = state.sort, va = k === 'note' ? note(a) : a[k], vb = k === 'note' ? note(b) : b[k];
    return typeof va === 'number' ? (va - vb) * state.dir : String(va).localeCompare(String(vb), 'ru') * state.dir;
  });
  const th = (k, label, cls = '') => `<th class="${cls}"><button data-sort="${k}"${state.sort === k ? ` aria-sort="${state.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${label}${state.sort === k ? (state.dir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`;
  const chip = g => `<button data-group="${g ? esc(g.key) : ''}" aria-pressed="${(g ? g.key : null) === state.group}">${g ? `<span class="sq" style="--g:${g.color}"></span>` : ''}${g ? esc(g.key) : 'Все'} <span class="c num">${g ? g.items.length : EXP.length}</span></button>`;
  return `<div style="display:grid;gap:var(--space-6)">
    <div class="summary">
      <div class="ls-block ls-block-pink ls-stat"><b>${fmt(total)}</b><span class="cap">всего за поездку</span><span class="cap cmp">${compare(total, 'total')}</span></div>
      <div class="ls-block ls-stat"><b>${perNight(total)}</b><span class="cap">в сутки, всё вместе</span><span class="cap cmp">${compare(nights ? total / nights : null, 'perDay')}</span></div>
      <div class="ls-block ls-stat"><b>${perNight(onSite)}</b><span class="cap">в сутки на месте, без жилья и дороги</span><span class="cap cmp">${compare(nights ? onSite / nights : null, 'onSiteDay')}</span></div>
    </div>
    <section class="section"><h2 class="ls-h">Куда ушли деньги</h2>
      <div class="ls-block cats"><div class="cat head"><span style="grid-area:name">Категория</span><span class="wide-only"></span><span class="col wide-only">Сумма</span><span class="col wide-only">Доля</span><span class="col wide-only">В сутки</span><span class="col narrow-only" style="grid-area:vals">Сумма</span></div>${catRows}</div>
    </section>
    <section class="section"><h2 class="ls-h" id="all-spend">Все траты</h2>
      <div class="filters">${chip(null)}${groups.map(chip).join('')}</div>
      <div class="table-box"><table class="ls-table">
        <thead><tr>${th('name', 'Название')}${th('amount', 'Сумма', 'num')}${th('category', 'Категория')}${th('note', 'Комментарий')}</tr></thead>
        <tbody>${rows.map(e => `<tr><td class="name">${esc(e.name)}</td><td class="num">${fmt(e.amount)}</td><td><span class="ls-tag ${groupOf(e.category).tag}">${esc(e.category)}</span></td><td class="note">${esc(note(e))}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Итого${state.group ? ' · ' + esc(state.group) : ''}</td><td class="num">${fmt(rows.reduce((s, e) => s + e.amount, 0))}</td><td colspan="2" class="cap">${rows.length} ${plural(rows.length, 'трата', 'траты', 'трат')}</td></tr></tfoot>
      </table></div>
    </section>
  </div>`;
}

/* ---------- Вещи ---------- */
const BAGS = [{ name: 'Чемодан', tag: 'ls-tag-lemon', color: 'var(--lemon)' }, { name: 'Ручная кладь', tag: 'ls-tag-sky', color: 'var(--sky)' },
  { name: 'На себя', tag: 'ls-tag-gray', color: 'var(--gray)' }, { name: 'Мини-сумка', tag: '', color: 'var(--pink)' }];
const DEFAULT_SECTIONS = ['Одежда и обувь', 'Уход и макияж', 'Другое', 'Супер-важное (документы и др)'];
const PACKUI = {};
const packUI = () => (PACKUI[TRIP.id] = PACKUI[TRIP.id] || { filter: null, hideDone: false, closed: new Set(), menu: null });
const packRefs = () => TRIP.packing.sections.flatMap((s, si) => s.items.map((it, ii) => ({ si, ii, it, sec: s.title, id: `${si}.${ii}` })));
function packTab() {
  const ui = packUI(), refs = packRefs();
  if (!TRIP.packing.sections.length) {
    const donors = Object.values(TRIPS).filter(t => t.id !== TRIP.id && (t.packing?.sections || []).some(s => s.items.length));
    return `<div class="ls-block"><div class="ls-empty starter" style="justify-items:center">${UMBRELLA}<span class="cap">Списка вещей пока нет.</span>
      ${CAN_WRITE ? `${donors.map(t => `<button class="ls-btn" data-copy="${esc(t.id)}">Скопировать из «${esc(t.title)}», ${esc(when(t).split(' · ')[0])}</button>`).join('')}<button class="ls-btn" data-blank>Начать с пустых разделов</button>` : ''}</div></div>`;
  }
  const done = refs.filter(r => r.it.done).length, left = refs.length - done;
  const bagOf = n => BAGS.find(b => b.name === n);
  const visible = r => (!ui.filter || (ui.filter === '—' ? !r.it.bag : r.it.bag === ui.filter)) && !(ui.hideDone && r.it.done);
  const chip = (key, label, color) => {
    const n = key === null ? refs.length : refs.filter(r => key === '—' ? !r.it.bag : r.it.bag === key).length;
    const sq = color === undefined ? '' : `<span class="sq${color === null ? ' white' : ''}" style="--g:${color || ''}"></span>`;
    return `<button data-bagf="${key === null ? '' : esc(key)}" aria-pressed="${ui.filter === key}">${sq}${esc(label)} <span class="c num">${n}</span></button>`;
  };
  const row = r => {
    const b = bagOf(r.it.bag);
    const menu = ui.menu === r.id ? `<div class="bagmenu" role="menu">${BAGS.map(x => `<button role="menuitem" data-setbag="${esc(x.name)}"><span class="ls-tag ${x.tag}">${esc(x.name)}</span></button>`).join('')}${b ? '<button role="menuitem" data-setbag="" class="cap">убрать место</button>' : ''}</div>` : '';
    return `<div class="pi${r.it.done ? ' done' : ''}${r.it.parent ? ' child' : ''}" data-id="${r.id}">
      <button class="box" data-act="done" aria-pressed="${!!r.it.done}" aria-label="${r.it.done ? 'Снять отметку' : 'Отметить'}: ${esc(r.it.text)}">${r.it.done ? '✓' : ''}</button>
      <span class="tx" data-act="done">${esc(r.it.text)}</span>
      <span class="bagwrap"><button class="ls-tag ${b ? b.tag : 'nobag'}" data-act="bag" aria-haspopup="menu" aria-expanded="${ui.menu === r.id}">${b ? esc(b.name) : 'куда?'}</button>${menu}</span>
      <button class="x w-only" data-act="del" title="Удалить" aria-label="Удалить: ${esc(r.it.text)}">×</button>
    </div>`;
  };
  const secHTML = TRIP.packing.sections.map((s, si) => {
    const all = refs.filter(r => r.si === si), doneS = all.filter(r => r.it.done).length, open = !ui.closed.has(s.title);
    let body = '';
    if (open) {
      const groups = [...new Set(all.map(r => r.it.group || ''))]; if (!groups.length) groups.push('');
      groups.forEach(gr => {
        let subNow = null, rows = '';
        all.filter(r => (r.it.group || '') === gr && visible(r)).forEach(r => { if ((r.it.sub || '') !== subNow) { subNow = r.it.sub || ''; if (subNow) rows += `<p class="ps">${esc(subNow)}</p>`; } rows += row(r); });
        body += `<div class="pgroup">${gr ? `<p class="pg">${esc(gr)}</p>` : ''}${rows}<label class="add w-only"><span aria-hidden="true">+</span><input data-add="${si}" data-group="${esc(gr)}" placeholder="добавить вещь" aria-label="Добавить вещь"></label></div>`;
      });
    }
    return `<section class="psec ls-block"><button class="psec-h" data-sec="${esc(s.title)}" aria-expanded="${open}"><span class="ls-h">${esc(s.title)}</span><span class="cap num">${doneS} из ${all.length}</span></button>${body}</section>`;
  }).join('');
  return `<div style="display:grid;gap:var(--space-6)">
    <div class="stats3">
      <div class="ls-block ls-stat"><b>${refs.length}</b><span class="cap">${plural(refs.length, 'вещь', 'вещи', 'вещей')} в списке</span></div>
      <div class="ls-block ls-stat"><b>${done}</b><span class="cap">собрано</span></div>
      <div class="ls-block ls-stat"><b>${left}</b><span class="cap">осталось</span></div>
    </div>
    <div class="frow"><div class="filters">${chip(null, 'Все')}${BAGS.map(b => chip(b.name, b.name, b.color)).join('')}${chip('—', 'Без места', null)}</div><button class="hidelink" data-hide aria-pressed="${ui.hideDone}">${ui.hideDone ? 'Показать собранное' : 'Скрыть собранное'}</button></div>
    <div class="psecs">${secHTML}</div>
  </div>`;
}
function packClick(e) {
  const ui = packUI();
  const cp = e.target.closest('[data-copy]');
  if (cp) { const src = TRIPS[cp.dataset.copy]; TRIP.packing.sections = src.packing.sections.map(s => ({ title: s.title, items: s.items.map(i => ({ ...i, done: false })) })); changed(); render(); return true; }
  if (e.target.closest('[data-blank]')) { TRIP.packing.sections = DEFAULT_SECTIONS.map(t => ({ title: t, items: [] })); changed(); render(); return true; }
  const sb = e.target.closest('[data-setbag]');
  if (sb) { if (!CAN_WRITE) return true; const r = packRefs().find(x => x.id === sb.closest('[data-id]').dataset.id); r.it.bag = sb.dataset.setbag || null; ui.menu = null; changed(); render(); return true; }
  const f = e.target.closest('[data-bagf]'); if (f) { const k = f.dataset.bagf || null; ui.filter = ui.filter === k ? null : k; ui.menu = null; render(); return true; }
  if (e.target.closest('[data-hide]')) { ui.hideDone = !ui.hideDone; ui.menu = null; render(); return true; }
  const sh = e.target.closest('[data-sec]'); if (sh) { const k = sh.dataset.sec; ui.closed.has(k) ? ui.closed.delete(k) : ui.closed.add(k); ui.menu = null; render(); return true; }
  const a = e.target.closest('[data-act]');
  if (!a) { if (ui.menu) { ui.menu = null; render(); return true; } return false; }
  if (!CAN_WRITE) return true;
  const id = a.closest('[data-id]').dataset.id, r = packRefs().find(x => x.id === id);
  if (a.dataset.act === 'done') { r.it.done = !r.it.done; ui.menu = null; changed(); }
  if (a.dataset.act === 'bag') ui.menu = ui.menu === id ? null : id;
  if (a.dataset.act === 'del') { TRIP.packing.sections[r.si].items.splice(r.ii, 1); ui.menu = null; changed(); }
  render(); return true;
}
function packAdd(input) {
  const text = input.value.trim(); if (!text) return;
  const si = +input.dataset.add, group = input.dataset.group, items = TRIP.packing.sections[si].items, ui = packUI();
  let at = -1; items.forEach((it, k) => { if ((it.group || '') === group) at = k; });
  const last = items[at];
  items.splice(at + 1, 0, { text, done: false, bag: ui.filter && ui.filter !== '—' ? ui.filter : null, group, sub: last ? last.sub || '' : '', parent: '' });
  changed(); render();
  const again = [...document.querySelectorAll('[data-add]')].find(x => x.dataset.add === String(si) && x.dataset.group === group); if (again) again.focus();
}

/* ---------- Места и еда: один список, «были» и «понравилось», траты привязаны по place ---------- */
const LISTUI = {};
function listTab(kind) {
  const arr = TRIP[kind], ui = (LISTUI[TRIP.id + kind] = LISTUI[TRIP.id + kind] || { filter: null, menu: null });
  const word = kind === 'food' ? ['заведение', 'заведения', 'заведений'] : ['место', 'места', 'мест'];
  const exOf = name => EXP.filter(e => e.place === name);
  const sumOf = name => exOf(name).reduce((s, e) => s + e.amount, 0);
  const visited = arr.filter(x => x.visited).length, spent = arr.reduce((s, x) => s + sumOf(x.name), 0);
  const lists = (TRIP.lists || []).filter(l => l.kind === kind);
  const shown = arr.map((x, i) => ({ x, i })).filter(({ x }) => !ui.filter || (ui.filter === 'yes' ? x.visited : !x.visited));
  const best = kind === 'food' ? arr.filter(x => x.rank).sort((a, b) => a.rank - b.rank) : [];
  const row = ({ x, i }) => {
    const ex = exOf(x.name), sum = ex.reduce((s, e) => s + e.amount, 0);
    const caption = x.address ? esc(x.address) : esc(x.city || ''); // в адресе Яндекса город уже есть
    const menu = ui.menu === i ? `<div class="costmenu">${ex.map(e => `<div><span>${esc(e.name)}</span><span class="num">${fmt(e.amount)}</span></div>`).join('')}</div>` : '';
    return `<div class="pl-row${x.visited ? '' : ' not'}" data-i="${i}">
      <button class="box" data-lact="visited" aria-pressed="${!!x.visited}" aria-label="${x.visited ? 'Были' : 'Отметить «были»'}: ${esc(x.name)}">${x.visited ? '✓' : ''}</button>
      <span class="nm"><span>${esc(x.name)}${x.rank ? ` <span class="cap">· ${x.rank}-е место</span>` : ''}</span>${caption ? `<span class="linked">${caption}</span>` : ''}${x.oid ? `<a href="https://yandex.ru/maps/org/${esc(x.oid)}" target="_blank" rel="noopener">в Яндекс Картах</a>` : ''}</span>
      <span class="cost">${sum ? `<button data-lact="cost" title="${esc(ex.map(e => e.name + ' — ' + fmt(e.amount)).join('\n'))}">${fmt(sum)}</button>${menu}` : ''}</span>
      <button class="heart" data-lact="liked" aria-pressed="${!!x.liked}" aria-label="Понравилось: ${esc(x.name)}">♥</button>
    </div>`;
  };
  const chip = (key, label, n) => `<button data-lfilter="${key || ''}" aria-pressed="${ui.filter === key}">${label} <span class="c num">${n}</span></button>`;
  return `<div style="display:grid;gap:var(--space-6)">
    <div class="stats3">
      <div class="ls-block ls-stat"><b>${arr.length}</b><span class="cap">${plural(arr.length, ...word)} в списке</span></div>
      <div class="ls-block ls-stat"><b>${visited}</b><span class="cap">были</span></div>
      <div class="ls-block ls-stat"><b>${spent ? fmt(spent) : '—'}</b><span class="cap">${kind === 'food' ? 'на еду в этих местах' : 'на места вместе с дорогой и едой там'}</span></div>
    </div>
    ${best.length ? `<section class="section"><h2 class="ls-h">Лучшие рестораны</h2><div class="podium3">${best.map(r => `<div class="ls-block pod"><span class="pl">${r.rank}</span><b>${esc(r.name)}</b><span class="cap">${sumOf(r.name) ? fmt(sumOf(r.name)) : ''}</span></div>`).join('')}</div></section>` : ''}
    <section class="section">
      ${lists.length ? `<p class="cap lists" style="margin:0">Из Яндекс Карт: ${lists.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>`).join(' ')}</p>` : ''}
      <div class="filters">${chip(null, 'Все', arr.length)}${chip('yes', 'Были', visited)}${chip('no', 'Не были', arr.length - visited)}</div>
      <div class="ls-block">${shown.map(row).join('') || '<p class="cap" style="margin:0">Здесь пусто.</p>'}
        <label class="add w-only"><span aria-hidden="true">+</span><input data-ladd="${kind}" placeholder="${kind === 'food' ? 'добавить заведение или блюдо' : 'добавить место'}" aria-label="Добавить"></label></div>
    </section>
  </div>`;
}
function listClick(e) {
  const kind = state.tab === 'Еда' ? 'food' : 'places', ui = LISTUI[TRIP.id + kind];
  const f = e.target.closest('[data-lfilter]'); if (f) { ui.filter = f.dataset.lfilter || null; ui.menu = null; render(); return true; }
  const a = e.target.closest('[data-lact]');
  if (!a) { if (ui && ui.menu !== null) { ui.menu = null; render(); return true; } return false; }
  const i = +a.closest('[data-i]').dataset.i, x = TRIP[kind][i];
  if (a.dataset.lact === 'cost') { ui.menu = ui.menu === i ? null : i; render(); return true; }
  if (!CAN_WRITE) return true;
  if (a.dataset.lact === 'visited') x.visited = !x.visited;
  if (a.dataset.lact === 'liked') x.liked = !x.liked;
  changed(); render(); return true;
}

/* ---------- Фото ---------- */
const PHUI = {};
const phUI = () => (PHUI[TRIP.id] = PHUI[TRIP.id] || { open: null, rnd: Math.random(), busy: false });
function placeOn(date) {
  if (!date) return '';
  const d = new Date(date), its = (TRIP.itinerary || []).filter(x => x.city && x.from);
  const stay = its.find(x => new Date(x.from) <= d && (!x.to || d < new Date(x.to))) || its.filter(x => x.to && new Date(x.to).getTime() === d.getTime()).pop();
  return `${d.getDate()} ${MON_GEN[d.getMonth()]}${stay ? ', ' + stay.city : ''}`;
}
function shrink(file) {
  return new Promise((ok, fail) => {
    const r = new FileReader(); r.onerror = fail;
    r.onload = () => { const img = new Image(); img.onerror = fail; img.onload = () => {
      const k = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); ok(c.toDataURL('image/jpeg', 0.82)); }; img.src = r.result; };
    r.readAsDataURL(file);
  });
}
function photosTab() {
  const P = TRIP.photos, ui = phUI();
  const addBtn = `<label class="ls-btn w-only" style="position:relative">${ui.busy ? 'Загружаю…' : 'Добавить фото'}<input type="file" accept="image/*" multiple id="phfile" style="position:absolute;inset:0;opacity:0;cursor:pointer" aria-label="Добавить фото"></label>`;
  if (!P.length) return `<div class="ls-block"><div class="ls-empty">${UMBRELLA}<span class="cap">Пока пусто — сюда лягут фото с поездки.</span>${addBtn}</div></div>`;
  const cover = P[Math.floor(ui.rnd * P.length) % P.length];
  return `<div style="display:grid;gap:var(--space-6)">
    <figure class="cover" style="margin:0"><img data-file="${esc(cover.file)}" alt="${esc(cover.caption || 'Обложка поездки')}"><figcaption class="cap">${cover.caption ? esc(cover.caption) + ' · ' : ''}${placeOn(cover.date)}</figcaption></figure>
    <section class="section"><h2 class="ls-h">${P.length} ${plural(P.length, 'снимок', 'снимка', 'снимков')}</h2>
      <div class="pgrid">${P.map((p, i) => `<button class="ph" data-ph="${i}" aria-label="Открыть фото"><img data-file="${esc(p.file)}" alt="">${p.caption ? `<span class="pcap">${esc(p.caption)}</span>` : ''}</button>`).join('')}
      <label class="addph w-only"><input type="file" accept="image/*" multiple id="phfile2" aria-label="Добавить фото"><span>${ui.busy ? 'Загружаю…' : '+ Добавить фото'}</span></label></div>
    </section>
  </div>`;
}
function lightbox() {
  const P = TRIP.photos, ui = phUI(); if (ui.open === null || !P[ui.open]) return '';
  const i = ui.open, p = P[i];
  return `<div class="lb" role="dialog" aria-label="Фото ${i + 1} из ${P.length}">
    <div class="lb-top"><span>${i + 1} из ${P.length}${p.date ? ' · ' + placeOn(p.date) : ''}</span><button data-lb="close" aria-label="Закрыть">×</button></div>
    <div class="lb-img"><button class="lb-nav" data-lb="prev" aria-label="Предыдущее">‹</button><img data-file="${esc(p.file)}" alt="${esc(p.caption)}"><button class="lb-nav" data-lb="next" aria-label="Следующее">›</button></div>
    <div class="lb-bar w-only"><input id="phcap" value="${esc(p.caption)}" placeholder="Подпись, пара слов" aria-label="Подпись к фото"><button class="ls-btn" data-lb="del">Удалить</button></div>
  </div>`;
}
function hydratePhotos() {
  document.querySelectorAll('img[data-file]').forEach(async img => { try { img.src = await blobURL(img.dataset.file); } catch (e) { img.alt = 'Не загрузилось'; } });
}
async function addPhotos(files) {
  const ui = phUI(); ui.busy = true; render();
  for (const f of files) {
    try {
      const data = await shrink(f), d = new Date(f.lastModified || Date.now());
      const stamp = d.toISOString().slice(0, 10), file = `photos/${TRIP.id}/${stamp}-${Math.random().toString(36).slice(2, 8)}.jpg`;
      await writeFile(file, data.split(',')[1], `«${TRIP.title}»: фото`);
      BLOBS[file] = data; TRIP.photos.push({ file, date: stamp, caption: '' }); changed();
    } catch (e) { setSave('Фото не загрузилось: ' + e.message, true); }
  }
  ui.busy = false; render();
}

/* ---------- события ---------- */
root.addEventListener('click', e => {
  const go = e.target.closest('[data-go]'); if (go) { location.hash = go.dataset.go ? `#/trip/${go.dataset.go}` : ''; return; }
  if (e.target.closest('#logout')) { LS.del('trips-token'); LS.del('trips-ro'); TOKEN = null; location.hash = ''; loginView(); return; }
  const tb = e.target.closest('[data-tab]'); if (tb) { history.replaceState(null, '', `#/trip/${TRIP.id}/${encodeURIComponent(tb.dataset.tab)}`); state.tab = tb.dataset.tab; render(); return; }
  if (!TRIP) return;
  if (state.tab === 'Вещи' && packClick(e)) return;
  if ((state.tab === 'Места' || state.tab === 'Еда') && listClick(e)) return;
  if (state.tab === 'Фото') {
    const ui = phUI(), o = e.target.closest('[data-ph]');
    if (o) { ui.open = +o.dataset.ph; render(); return; }
    const lb = e.target.closest('[data-lb]');
    if (lb) {
      const P = TRIP.photos, i = ui.open, cap = document.getElementById('phcap');
      if (cap && P[i] && cap.value.trim() !== (P[i].caption || '')) { P[i].caption = cap.value.trim(); changed(); }
      const act = lb.dataset.lb;
      if (act === 'close') ui.open = null;
      if (act === 'prev') ui.open = (i - 1 + P.length) % P.length;
      if (act === 'next') ui.open = (i + 1) % P.length;
      if (act === 'del' && CAN_WRITE) { const [gone] = P.splice(i, 1); deleteFile(gone.file, `«${TRIP.title}»: удалено фото`).catch(() => {}); changed(); ui.open = P.length ? Math.min(i, P.length - 1) : null; }
      render(); return;
    }
  }
  const s = e.target.closest('[data-sort]');
  if (s) { const k = s.dataset.sort; state.dir = state.sort === k ? -state.dir : (k === 'amount' ? -1 : 1); state.sort = k; render(); return; }
  const pk = e.target.closest('[data-pick]');
  if (pk) { state.group = state.group === pk.dataset.pick ? null : pk.dataset.pick; render(); if (state.group) document.getElementById('all-spend').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
  const g = e.target.closest('[data-group]');
  if (g && state.tab === 'Траты') { state.group = g.dataset.group || null; render(); }
});
root.addEventListener('keydown', e => {
  if (e.key !== 'Enter') { const pk = e.target.closest('[data-pick]'); if (pk && e.key === ' ') { e.preventDefault(); pk.click(); } return; }
  const t = e.target;
  if (t.matches('[data-pick]')) { e.preventDefault(); t.click(); return; }
  if (!CAN_WRITE) return;
  if (t.matches('[data-add]')) { e.preventDefault(); packAdd(t); return; }
  if (t.matches('[data-ladd]')) { e.preventDefault(); const v = t.value.trim(); if (!v) return; TRIP[t.dataset.ladd].push({ name: v, city: null, visited: false, liked: false }); changed(); render(); const n = document.querySelector(`[data-ladd="${t.dataset.ladd}"]`); if (n) n.focus(); return; }
  if (t.matches('[data-note]')) { e.preventDefault(); const v = t.value.trim(); if (!v) return; TRIP.notes.push({ section: null, text: v }); changed(); render(); const n = document.querySelector('[data-note]'); if (n) n.focus(); }
});
root.addEventListener('change', e => { if ((e.target.id === 'phfile' || e.target.id === 'phfile2') && e.target.files.length && CAN_WRITE) addPhotos([...e.target.files]); });
document.addEventListener('keydown', e => {
  if (!TRIP || state.tab !== 'Фото' || phUI().open === null || e.target.id === 'phcap') return;
  const map = { Escape: 'close', ArrowLeft: 'prev', ArrowRight: 'next' }, b = map[e.key] && document.querySelector(`[data-lb="${map[e.key]}"]`); if (b) b.click();
});

boot();
