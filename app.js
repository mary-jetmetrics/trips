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
const TRIPS = {}, SHA = {}, BLOBS = {}, ORIG = {};   // ORIG — карточка поездки, как она лежит в репозитории (для слияния правок)
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
const PEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z M9 4l3 3"/></svg>';
const CHEV = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 L5 6.5 L8 3.5"/></svg>';
const GRIP = '<svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.3"/><circle cx="6" cy="2" r="1.3"/><circle cx="2" cy="7" r="1.3"/><circle cx="6" cy="7" r="1.3"/><circle cx="2" cy="12" r="1.3"/><circle cx="6" cy="12" r="1.3"/></svg>';
const WAVE = '<svg class="ls-wave" viewBox="0 0 190 8" aria-hidden="true"><path d="M1 4 Q 6 0 11 4 T 21 4 T 31 4 T 41 4 T 51 4 T 61 4 T 71 4 T 81 4 T 91 4 T 101 4 T 111 4 T 121 4 T 131 4 T 141 4 T 151 4 T 161 4 T 171 4 T 181 4"/></svg>';
const UMBRELLA = '<svg class="ls-umbrella" width="40" height="40" viewBox="0 0 46 46" aria-hidden="true"><g transform="rotate(-14 23 23)"><path class="canopy" d="M8 20 A15 11 0 0 1 38 20 Z"/><path class="stripe" d="M23 20 L8 20 A15 11 0 0 1 12.5 12.2 Z"/><path class="stripe" d="M23 20 L18 9.3 A15 11 0 0 1 28 9.3 Z"/><path class="stripe" d="M23 20 L33.5 12.2 A15 11 0 0 1 38 20 Z"/><line class="stick" x1="23" y1="20" x2="22" y2="40"/></g></svg>';

/* ---------- GitHub ---------- */
async function gh(path, opts = {}) {
  const r = await fetch(API + path, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) { const e = new Error('GitHub ответил ' + r.status); e.status = r.status; throw e; }
  return r;
}
async function readJSON(file) { const j = await (await gh(`/contents/${file}?ref=${BRANCH}`, { cache: 'no-store' })).json(); SHA[file] = j.sha; return JSON.parse(b64dec(j.content)); }
async function writeFile(file, base64, message) {
  const body = { message, content: base64, branch: BRANCH }; if (SHA[file]) body.sha = SHA[file];
  const j = await (await gh(`/contents/${file}`, { method: 'PUT', body: JSON.stringify(body) })).json(); SHA[file] = j.content.sha;
}
async function deleteFile(file, message) {
  if (!SHA[file]) SHA[file] = (await (await gh(`/contents/${file}?ref=${BRANCH}`, { cache: 'no-store' })).json()).sha;
  await gh(`/contents/${file}`, { method: 'DELETE', body: JSON.stringify({ message, sha: SHA[file], branch: BRANCH }) }); delete SHA[file];
}
async function blobURL(file) {
  if (!BLOBS[file]) BLOBS[file] = URL.createObjectURL(await (await gh(`/contents/${file}?ref=${BRANCH}`, { headers: { Accept: 'application/vnd.github.raw' } })).blob());
  return BLOBS[file];
}

/* ---------- сохранение: правка → через секунду карточка уходит в репозиторий ---------- */
let saveTimer = null, saving = false, dirty = false, conflicts = 0;
function setSave(text, err) { const el = document.getElementById('save'); if (el) { el.textContent = text; el.classList.toggle('err', !!err); } }
function changed() { if (!CAN_WRITE) return; dirty = true; setSave('Сохраняю…'); clearTimeout(saveTimer); saveTimer = setTimeout(flush, 1000); }
// карточку правили и здесь, и в другом месте (инбокс, гардероб, другое устройство): берём из обеих версий то, что поменялось;
// одно и то же поле поменяли обе — побеждает эта; списки разной длины поменяли обе — не сливаем (null)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge3(base, mine, theirs) {
  if (same(mine, base)) return theirs;
  if (same(theirs, base) || same(mine, theirs)) return mine;
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs)) {
    if (mine.length !== base.length || theirs.length !== base.length) throw new Error('списки не сливаются');
    return base.map((b, i) => merge3(b, mine[i], theirs[i]));
  }
  if (isObj(base) && isObj(mine) && isObj(theirs)) {
    const out = {};
    new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)]).forEach(k => { const v = merge3(base[k], mine[k], theirs[k]); if (v !== undefined) out[k] = v; });
    return out;
  }
  return mine;
}
async function flush() {
  if (saving) { saveTimer = setTimeout(flush, 700); return; }
  if (!dirty || !TRIP) return;
  saving = true; dirty = false;
  const t = TRIP, file = `trips/${t.id}.json`, text = JSON.stringify(t, null, 1);
  try {
    await writeFile(file, b64enc(text), `«${t.title}»: правки из приложения`);
    ORIG[t.id] = text; conflicts = 0; setSave('Сохранено');
  } catch (e) {
    if (e.status === 403) { CAN_WRITE = false; document.body.classList.add('ro'); setSave('У этого ключа только просмотр — правки не сохраняются', true); }
    else if (e.status === 409 || e.status === 422) {
      try {
        const fresh = await readJSON(file);
        let merged = null;
        if (ORIG[t.id] && conflicts < 3) try { merged = merge3(JSON.parse(ORIG[t.id]), JSON.parse(JSON.stringify(TRIPS[t.id])), fresh); } catch (e3) { merged = null; }
        ORIG[t.id] = JSON.stringify(fresh);
        TRIPS[t.id] = merged || fresh; if (TRIP && TRIP.id === t.id) { setTrip(t.id); render(); }
        if (merged) { conflicts++; dirty = true; setSave('Сохраняю…'); clearTimeout(saveTimer); saveTimer = setTimeout(flush, 0); }
        else { conflicts = 0; setSave('Подтянула правки с другого устройства — повтори последнее действие', true); }
      } catch (e2) { dirty = true; setSave('Не сохранилось, проверь интернет', true); }
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
    await Promise.all(INDEX.map(async t => { TRIPS[t.id] = await readJSON(`trips/${t.id}.json`); ORIG[t.id] = JSON.stringify(TRIPS[t.id]); }));
    try { BASE = await readJSON('packing-base.json'); } catch (e) { BASE = null; }
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
    const tab = m[2] ? decodeURIComponent(m[2]) : null;
    state.tab = tab === 'Вещи' ? 'Чемодан' : tab || 'Обзор';   // поездка открывается на «Обзоре» (Мария, 12.10.26)
    tripView();
  } else catalogView();
  window.scrollTo(0, 0);
}

/* ---------- каталог ---------- */
// главная — лента по годам (Мария, 12.10.26): значок типа на линии, метка «сегодня» между будущим и прошлым,
// у предстоящих — даты, ночи, «через N дней»; у прошедших — даты, ночи, деньги и стопка из трёх фото справа
const TYPES = {
  beach: ['пляж', 'var(--lemon)', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="9" r="3.2"/><path d="M12 2.8 V4 M5.8 9 H7 M17 9 H18.2 M7.6 4.6 L8.4 5.4 M16.4 4.6 L15.6 5.4"/><path d="M3 16 q2.25 -2.2 4.5 0 t4.5 0 t4.5 0 t4.5 0 M5 20 q1.75 -1.6 3.5 0 t3.5 0 t3.5 0 t3.5 0"/></svg>'],
  city: ['город', 'var(--lavender)', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20 H21 M5 20 V10 H10 V20 M10 20 V5 H17 V20 M17 20 V12 H20 V20"/><path d="M12.5 8.5 H14.5 M12.5 11.5 H14.5 M12.5 14.5 H14.5 M7 13 H8 M7 16 H8"/></svg>'],
  nature: ['природа', 'var(--salad)', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 19.5 L9 9 L13 15.5 L15.5 12 L21.5 19.5 Z"/><path d="M7.4 11.6 L9 12.6 L10.4 11.4"/><circle cx="17.5" cy="6" r="2"/></svg>'],
};
const typeOf = t => TYPES[t.type] ? t.type : 'city';
const isPast = t => t.dates ? ended(t) : (t.month || '') < new Date().toISOString().slice(0, 7);
const startOf = t => (t.dates ? t.dates.start : t.month) || '';
function countdown(t) {
  if (!t.dates) return 'даты уточняются';
  const a = new Date(t.dates.start + 'T00:00:00'), b = new Date(t.dates.end + 'T00:00:00'), now = today();
  if (now >= a && now <= b) { const k = Math.round((now - a) / 864e5) + 1; return `идёт сейчас · день ${k} из ${nightsOf(t) + 1}`; }
  const n = Math.round((a - now) / 864e5);
  return n === 0 ? 'сегодня' : n === 1 ? 'завтра' : `через ${n} ${plural(n, 'день', 'дня', 'дней')}`;
}
let TYPE_MENU = null, NEW_FORM = false;   // у какой поездки открыт выбор типа; открыта ли форма новой поездки
function typeBadge(t) {
  const [name, color, svg] = TYPES[typeOf(t)];
  const menu = TYPE_MENU === t.id ? `<div class="tmenu" role="menu">${Object.entries(TYPES).map(([k, [n, c, i]]) =>
    `<button role="menuitemradio" aria-checked="${k === typeOf(t)}" data-settype="${k}" data-id="${esc(t.id)}"><span class="tbadge" style="--cb:${c}">${i}</span>${n}</button>`).join('')}</div>` : '';
  return CAN_WRITE
    ? `<button class="tbadge on-line" style="--cb:${color}" data-typemenu="${esc(t.id)}" aria-haspopup="menu" aria-expanded="${TYPE_MENU === t.id}" title="${name} — нажми, чтобы поменять">${svg}</button>${menu}`
    : `<span class="tbadge on-line" style="--cb:${color}" title="${name}">${svg}</span>`;
}
function photoStack(t) {
  const P = t.photos || []; if (!P.length) return '';
  const pick = P.length <= 3 ? P : [P[0], P[Math.floor(P.length / 2)], P[P.length - 1]];
  return `<span class="stack" aria-hidden="true">${pick.map(p => `<img data-file="${esc(p.file)}" alt="">`).join('')}</span>`;
}
const spentOf = t => (t.expenses || []).reduce((s, x) => s + (x.amount || 0), 0);
function tripItem(t) {
  const past = isPast(t), spent = spentOf(t);
  return `<div class="it${past ? '' : ' soon'}">${typeBadge(t)}
    <button class="it-go" data-go="${esc(t.id)}"><span class="txt"><b>${esc(t.title)}</b><span class="cap">${esc(when(t))}</span>
      ${past ? (spent ? `<span class="cap">${fmt(spent)}</span>` : '') : `<span><span class="ls-tag">${countdown(t)}</span></span>`}</span>${past ? photoStack(t) : ''}</button></div>`;
}
function newTripForm() {
  const m = new Date().toISOString().slice(0, 7);
  return `<form class="ls-block newtrip" id="newtrip">
    <h2 class="ls-h">Новая поездка</h2>
    <label class="f cap">Название<input name="title" required placeholder="Например, Фукуок" autocomplete="off"></label>
    <span class="cap">Какая поездка</span>
    <div class="types">${Object.entries(TYPES).map(([k, [n, c, i]], j) => `<label><input type="radio" name="type" value="${k}"${j === 0 ? ' checked' : ''}><span><span class="tbadge" style="--cb:${c}">${i}</span>${n}</span></label>`).join('')}</div>
    <div class="two" id="nt-dates"><label class="f cap">Туда<input type="date" name="start"></label><label class="f cap">Обратно<input type="date" name="end"></label></div>
    <label class="f cap" id="nt-month" hidden>Месяц<input type="month" name="month" value="${m}"></label>
    <label class="chk"><input type="checkbox" name="nodates" id="nt-nodates"> Даты пока не знаю</label>
    <p class="cap">Чемодан, места, еда и траты появятся пустыми — заполнишь внутри.</p>
    <p class="cap err" id="nt-err" hidden></p>
    <div class="acts"><button class="ls-btn ls-btn-main" type="submit">Создать</button><button class="ls-btn" type="button" data-newtrip="close">Отмена</button></div>
  </form>`;
}
function catalogView() {
  TRIP = null;
  const all = INDEX.map(x => TRIPS[x.id]).filter(Boolean).sort((a, b) => startOf(b).localeCompare(startOf(a)));
  const now = today();
  const mark = `<div class="today"><svg viewBox="0 0 60 8" aria-hidden="true"><path d="M1 4 Q 4 0 7 4 T 13 4 T 19 4 T 25 4 T 31 4 T 37 4 T 43 4 T 49 4 T 55 4"/></svg>сегодня, ${now.getDate()} ${MON_GEN[now.getMonth()]}</div>`;
  let line = '', year = null, marked = false;
  for (const t of all) {
    if (isPast(t) && !marked) { line += mark; marked = true; }
    const y = startOf(t).slice(0, 4);
    if (y !== year) { year = y; line += `<p class="yr">${y}</p>`; }
    line += tripItem(t);
  }
  if (!marked) line += mark;
  root.innerHTML = `<header class="head"><div class="topbar"><h1 class="ls-title">Поездки</h1>
      <div class="topacts"><button class="ls-btn ls-btn-main w-only" data-newtrip="open">+ Новая поездка</button><button class="back" id="logout">Выйти</button></div></div>${WAVE}
    <p class="cap" style="margin:0">${INDEX.length} ${plural(INDEX.length, 'поездка', 'поездки', 'поездок')}${CAN_WRITE ? '' : ' · только просмотр'} <span class="save" id="save"></span></p></header>
    ${NEW_FORM && CAN_WRITE ? newTripForm() : ''}
    <div class="tl">${line}</div>`;
  hydratePhotos();
}
// тип поездки меняется прямо на главной: значок → меню из трёх → сразу в репозиторий
async function setType(id, type) {
  const t = TRIPS[id], file = `trips/${id}.json`; TYPE_MENU = null;
  if (!t || t.type === type) return catalogView();
  t.type = type; catalogView(); setSave('Сохраняю…');
  try {
    try { await writeFile(file, b64enc(JSON.stringify(t, null, 1)), `«${t.title}»: тип поездки`); ORIG[id] = JSON.stringify(t); }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e; const fresh = await readJSON(file); fresh.type = type; TRIPS[id] = fresh; await writeFile(file, b64enc(JSON.stringify(fresh, null, 1)), `«${t.title}»: тип поездки`); ORIG[id] = JSON.stringify(fresh); }
    setSave('Сохранено');
  } catch (e) { setSave('Не сохранилось, проверь интернет', true); }
}
const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const slug = s => s.toLowerCase().split('').map(c => TR[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
async function createTrip(form) {
  const f = new FormData(form), err = document.getElementById('nt-err');
  const title = String(f.get('title') || '').trim(), nodates = !!f.get('nodates'), start = f.get('start'), end = f.get('end');
  const fail = m => { err.textContent = m; err.hidden = false; };
  if (!title) return fail('Напиши название.');
  if (!nodates && (!start || !end)) return fail('Укажи даты туда и обратно или отметь «Даты пока не знаю».');
  if (!nodates && end < start) return fail('Дата «обратно» раньше, чем «туда».');
  const month = nodates ? String(f.get('month') || new Date().toISOString().slice(0, 7)) : start.slice(0, 7);
  let id = `${month}-${slug(title) || 'poezdka'}`; for (let k = 2; TRIPS[id]; k++) id = `${month}-${slug(title) || 'poezdka'}-${k}`;
  const trip = { id, title, type: f.get('type') || 'city', month, dates: nodates ? null : { start, end }, transport: [], from: 'Пермь', itinerary: [],
    expenses: [], packing: { sections: DEFAULT_SECTIONS.map(title => ({ title, items: [] })) }, places: [], food: [], lists: [], notes: [], photos: [] };
  const btn = form.querySelector('[type=submit]'); btn.disabled = true; btn.textContent = 'Создаю…';
  try {
    await writeFile(`trips/${id}.json`, b64enc(JSON.stringify(trip, null, 1)), `«${title}»: новая поездка`);
    const idx = await readJSON('index.json');            // свежий список: вдруг правили с другого устройства
    idx.unshift({ id, title, month, dates: trip.dates });
    await writeFile('index.json', b64enc(JSON.stringify(idx, null, 1)), `«${title}»: в список поездок`);
    INDEX = idx; TRIPS[id] = trip; ORIG[id] = JSON.stringify(trip); NEW_FORM = false; location.hash = `#/trip/${id}`;
  } catch (e) { btn.disabled = false; btn.textContent = 'Создать'; fail('Не получилось создать: проверь интернет и нажми ещё раз.'); }
}

/* ---------- карточка поездки ---------- */
const TABS = ['Обзор', 'Чемодан', 'Места', 'Еда', 'Траты', 'Фото'];
function setTrip(id) {
  TRIP = TRIPS[id];
  TRIP.packing = TRIP.packing || { sections: [] };
  TRIP.packing.sections.forEach(x => { if (OLD_TITLES[x.title]) x.title = OLD_TITLES[x.title]; });
  if (!isPast(TRIP)) {
    const has = new Set(TRIP.packing.sections.map(x => x.title)), order = t => { const i = DEFAULT_SECTIONS.indexOf(t); return i < 0 ? 99 : i; };
    DEFAULT_SECTIONS.forEach(t => { if (!has.has(t)) TRIP.packing.sections.push({ title: t, items: [] }); });
    TRIP.packing.sections.sort((a, b) => order(a.title) - order(b.title));
  }
  TRIP.places = TRIP.places || []; TRIP.food = TRIP.food || []; TRIP.photos = TRIP.photos || []; TRIP.notes = TRIP.notes || [];
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
  const views = { 'Обзор': () => overviewTab() + lightbox(), 'Чемодан': packTab, 'Места': () => listTab('places'), 'Еда': () => listTab('food'), 'Траты': spend, 'Фото': () => photosTab() + lightbox() };
  pane.innerHTML = (views[state.tab] || spend)();
  if (state.tab === 'Фото' || state.tab === 'Обзор') hydratePhotos();
  if (state.tab === 'Чемодан') hydrateWardrobe();
}

/* ---------- Обзор: сводка поездки (вариант А, Мария, 12.10.26) ---------- */
// до поездки: шапка (через сколько дней, тип, дорога, жильё) и плитки — чемодан, оплачено, еда и места на примете списком;
// после: та же шапка, лента фото (открываются на весь экран), деньги по группам, три лучших заведения и места со звёздами
const OV_ICON = {
  suit: '<svg viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="3" rx="1.2"/><rect x="5" y="6.5" width="14" height="13" rx="2"/><path d="M5 12 H19"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21 C7 15.5 5 12.5 5 9.5 a7 7 0 0 1 14 0 c0 3 -2 6 -7 11.5 Z"/><circle cx="12" cy="9.5" r="2.4"/></svg>',
  food: '<svg viewBox="0 0 24 24"><path d="M7 3 V11 M5 3 V8 a2 2 0 0 0 4 0 V3 M7 11 V21 M16 21 V3 c-2.5 1.5 -3 4 -3 7 h3"/></svg>',
  rub: '<svg viewBox="0 0 24 24"><path d="M9 20 V4 H14 a4 4 0 0 1 0 8 H6 M6 16 H14"/></svg>',
  plane: '<svg viewBox="0 0 24 24"><path d="M3 11 L21 4 L15 20 L11 13 Z M11 13 L21 4"/></svg>',
  car: '<svg viewBox="0 0 24 24"><rect x="3" y="10" width="18" height="6" rx="2"/><path d="M6 10 L8 6 H16 L18 10"/><circle cx="7.5" cy="17.5" r="1.6"/><circle cx="16.5" cy="17.5" r="1.6"/></svg>',
};
const ovIb = (k, c) => `<span class="ov-ib" style="--cb:${c}">${OV_ICON[k]}</span>`;
const MONEY_GROUPS = [['Дорога', ['Дорога'], 'var(--sky)'], ['Жильё', ['Жильё'], 'var(--pink)'], ['Еда', ['Готовая еда', 'Продукты'], 'var(--lemon)'], ['Остальное', null, 'var(--gray)']];
const STARS = ['★★★', '★★', '★'];
function agoText(t) {   // «закончилась 5 дней назад», «… 3 месяца назад», «… 1 год и 2 месяца назад»
  const end = t.dates ? new Date(t.dates.end + 'T00:00:00') : new Date((t.month || '') + '-28T00:00:00'), now = today();
  const days = Math.max(1, Math.round((now - end) / 864e5));
  if (days < 45) return `закончилась ${days} ${plural(days, 'день', 'дня', 'дней')} назад`;
  const months = (now.getFullYear() - end.getFullYear()) * 12 + now.getMonth() - end.getMonth();
  if (months < 12) return `закончилась ${months} ${plural(months, 'месяц', 'месяца', 'месяцев')} назад`;
  const y = Math.floor(months / 12), m = months % 12;
  return `закончилась ${y} ${plural(y, 'год', 'года', 'лет')}${m ? ` и ${m} ${plural(m, 'месяц', 'месяца', 'месяцев')}` : ''} назад`;
}
// плашка заведения или места: цвет по оценке (Мария, 12.10.26): от 8 — зелёный, 4–7 — жёлтый, ниже 4 — красный; были без оценки — с галочкой
const rateTone = r => r >= 8 ? 'good' : r >= 4 ? 'mid' : 'bad';
// плашка еды с заведением в Яндексе — ссылка на него в Яндекс Картах (Мария, 12.10.26); у мест ссылок нет
const ovChip = x => {
  const cls = x.rating ? `r-${rateTone(x.rating)}` : x.visited ? 'r-seen' : '';
  const attrs = (cls ? ` class="${cls}"` : '') + (x.rating ? ` title="${x.rating} из 10"` : '');   // только цвет, без цифры (Мария, 12.10.26)
  const text = (x.visited && !x.rating ? '✓ ' : '') + esc(x.name);
  return x.oid && TRIP.food.includes(x) ? `<a href="https://yandex.ru/maps/org/${esc(x.oid)}" target="_blank" rel="noopener"${attrs}>${text}</a>` : `<span${attrs}>${text}</span>`;
};
function ovTop3(arr) {
  const rated = arr.filter(x => x.rating).sort((a, b) => b.rating - a.rating).slice(0, 3);
  if (rated.length) return rated;
  return arr.filter(x => x.rank).sort((a, b) => a.rank - b.rank).slice(0, 3);   // архив: рейтинг из Notion
}
function overviewTab() {
  const T = TRIP, past = isPast(T), [tname, tcolor, tsvg] = TYPES[typeOf(T)];
  const its = T.itinerary || [], moves = its.filter(x => x.move), stays = its.filter(x => x.city);
  const cities = [...new Set(stays.map(x => x.city))], stayNames = [...new Set(stays.map(x => x.stay).filter(Boolean))];
  const by = (moves[0] || {}).by || (T.transport || [])[0];
  // один город — «Пермь → Калининград · Зеленоградск · «Парк Хаус»»; несколько — путь по городам
  const route = cities.length > 1 ? [T.from || ((moves[0] || {}).move || '').split(' → ')[0], ...cities].filter(Boolean).join(' → ')
    : [moves[0] && moves[0].move, cities[0], stayNames.length ? `«${stayNames.join('», «')}»` : ''].filter(Boolean).join(' · ');
  const headBlock = `<div class="ls-block ov-head"><div class="ov-row">${past ? `<span class="ls-tag ls-tag-white">${agoText(T)}</span>` : `<span class="ls-tag">${countdown(T)}</span>`}
      <span class="ov-chip"><span class="tbadge" style="--cb:${tcolor}">${tsvg}</span>${tname}</span></div>
    ${route ? `<span class="ov-route">${OV_ICON[by === 'машина' ? 'car' : 'plane']}<span>${esc(route)}</span></span>` : ''}</div>`;
  let notesHtml = '', head = null;
  T.notes.forEach(n => { if (n.section && n.section !== head) { head = n.section; notesHtml += `<h3>${esc(head)}</h3>`; } notesHtml += `<p>${esc(n.text).replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')}</p>`; });
  const notes = `<section class="section"><h2 class="ls-h">Заметки</h2><div class="ls-block notes">${notesHtml || '<p class="cap">Пока без заметок. Наличные траты в поездке можно записывать сюда.</p>'}
      <label class="add w-only"><span aria-hidden="true">+</span><input data-note placeholder="добавить заметку" aria-label="Добавить заметку"></label></div></section>`;
  const chips = arr => arr.length ? `<div class="ov-chips">${arr.map(ovChip).join('')}</div>` : '<p class="cap">Пока пусто.</p>';
  if (!past) {
    const refs = (T.packing.sections || []).flatMap(x => x.items), done = refs.filter(i => i.done).length;
    const paid = EXP.reduce((a, e) => a + e.amount, 0), cats = {};
    EXP.forEach(e => { cats[e.category] = (cats[e.category] || 0) + e.amount; });
    return `<div class="ov">${headBlock}
      <div class="ov-tiles">
        <div class="ls-block ov-tile"><div class="ov-top"><span class="cap">Чемодан</span>${ovIb('suit', 'var(--lemon)')}</div><b class="ov-big">${done} из ${refs.length}</b>
          <div class="ov-bar"><i style="width:${refs.length ? done / refs.length * 100 : 0}%;background:var(--lemon)"></i></div><span class="cap">собрано</span></div>
        <div class="ls-block ov-tile"><div class="ov-top"><span class="cap">Оплачено</span>${ovIb('rub', 'var(--pink)')}</div><b class="ov-big">${paid ? fmt(paid) : '—'}</b>
          <span class="cap">${Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${esc(k.toLowerCase())} ${fmt(v)}`).join(' · ')}</span></div>
        <div class="ls-block ov-tile wide"><div class="ov-top"><span class="cap">Еда на примете · ${T.food.length}</span>${ovIb('food', 'var(--sand)')}</div>${chips(T.food)}</div>
        <div class="ls-block ov-tile wide"><div class="ov-top"><span class="cap">Места на примете · ${T.places.length}</span>${ovIb('pin', 'var(--sky)')}</div>${chips(T.places)}</div>
      </div>${notes}</div>`;
  }
  // прошедшая поездка
  const P = T.photos || [], total = EXP.reduce((a, e) => a + e.amount, 0), n = nightsOf(T);
  const groups = MONEY_GROUPS.map(([name, cs, color]) => [name, EXP.filter(e => cs ? cs.includes(e.category) : !MONEY_GROUPS.some(g => g[1] && g[1].includes(e.category))).reduce((a, e) => a + e.amount, 0), color]);
  const top = (arr, kind) => { const t3 = ovTop3(arr);
    if (!t3.length) return `${chips(arr.filter(x => x.visited))}<p class="cap">Поставь оценки во вкладке «${kind}» — здесь соберутся три лучших.</p>`;
    return `<div class="ov-pod">${t3.map((x, i) => `<div><span class="ov-stars" aria-label="${3 - i} из 3">${STARS[i]}</span><span>${esc(x.name)}</span>${x.rating ? `<span class="cap">${x.rating} из 10</span>` : ''}</div>`).join('')}</div>`; };
  return `<div class="ov">${headBlock}
    ${P.length ? `<div class="ov-film">${P.map((p, i) => `<button class="ph" data-ph="${i}" aria-label="Открыть фото"><img data-file="${esc(p.file)}" alt=""></button>`).join('')}</div>` : ''}
    <div class="ls-block ov-money"><div class="ov-top"><span class="cap">Траты за поездку</span>${ovIb('rub', 'var(--pink)')}</div>
      <b class="ov-big">${total ? fmt(total) : '—'}</b><span class="cap">${[n ? `${n} ${plural(n, 'ночь', 'ночи', 'ночей')}` : '', n && total ? `${fmt(total / n)} в сутки` : ''].filter(Boolean).join(' · ')}</span>
      ${total ? `<div class="ov-stack">${groups.filter(g => g[1]).map(([nm, v, c]) => `<i style="width:${v / total * 100}%;background:${c}" title="${nm}"></i>`).join('')}</div>
      <div class="ov-groups">${groups.filter(g => g[1]).map(([nm, v, c]) => `<div><span class="sq" style="--g:${c}"></span><span>${nm} <span class="cap">${Math.round(v / total * 100)}%</span></span><b>${fmt(v)}</b></div>`).join('')}</div>` : ''}</div>
    <div class="ov-tiles">
      <div class="ls-block ov-tile wide"><div class="ov-top"><span class="cap">Лучшая еда</span>${ovIb('food', 'var(--sand)')}</div>${top(T.food, 'Еда')}</div>
      <div class="ls-block ov-tile wide"><div class="ov-top"><span class="cap">Лучшие места</span>${ovIb('pin', 'var(--sky)')}</div>${top(T.places, 'Места')}</div>
    </div>${notes}</div>`;
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

/* ---------- Чемодан (бывшая вкладка «Вещи») ---------- */
// «Мини-сумки» больше нет — это та же ручная кладь, делить их Мария не хочет (15.10.26)
const BAGS = [{ name: 'Чемодан', tag: 'ls-tag-lemon', color: 'var(--lemon)' }, { name: 'Ручная кладь', tag: 'ls-tag-sky', color: 'var(--sky)' },
  { name: 'На себя', tag: 'ls-tag-gray', color: 'var(--gray)' }];
const SUB_GROUPS = new Set(['Верх', 'Низ', 'Аксессуары']);   // где в «Чемодане» нужны подзаголовки подгрупп
// разделы чемодана: одежда приходит из гардероба; у «Ухода», «Другого», «Супер-важного» и «Еды в дорогу» есть
// базовый список (packing-base.json); в «Еде в дорогу» только леденцы и перекус, остальное каждый раз своё (Мария, 12.10.26)
const DEFAULT_SECTIONS = ['Одежда и обувь', 'Уход и макияж', 'Другое', 'Супер-важное', 'Еда в дорогу'];
const OLD_TITLES = { 'Супер-важное (документы и др)': 'Супер-важное' };
let BASE = null;
const baseOf = title => BASE && (BASE.sections || []).find(x => x.title === title);
const PACKUI = {};
const packUI = () => (PACKUI[TRIP.id] = PACKUI[TRIP.id] || { filter: null, hideDone: false, closed: new Set(), folded: new Set(), menu: null });
const packRefs = () => TRIP.packing.sections.flatMap((s, si) => s.items.map((it, ii) => ({ si, ii, it, sec: s.title, id: `${si}.${ii}` })));
function packTab() {
  const ui = packUI(), refs = packRefs();
  if (!TRIP.packing.sections.length) {
    const donors = Object.values(TRIPS).filter(t => t.id !== TRIP.id && (t.packing?.sections || []).some(s => s.items.length));
    return `<div class="ls-block"><div class="ls-empty starter" style="justify-items:center">${UMBRELLA}<span class="cap">Списка вещей пока нет.</span>
      ${CAN_WRITE ? `${donors.map(t => `<button class="ls-btn" data-copy="${esc(t.id)}">Скопировать из «${esc(t.title)}», ${esc(when(t).split(' · ')[0])}</button>`).join('')}<button class="ls-btn" data-blank>Начать с пустых разделов</button>` : ''}</div></div>`;
  }
  const anyOpen = TRIP.packing.sections.some(s => !ui.closed.has(s.title));   // «Свернуть всё» рядом со «Скрыть собранное» (Мария, 15.10.26, вариант В1)
  const bagOf = n => BAGS.find(b => b.name === n);
  // место выбирается только у верхнего уровня: подпункт «Аптечки», «Проводов» лежит там же, где группа (Мария, 15.10.26)
  const parentOf = r => r.it.parent ? TRIP.packing.sections[r.si].items.find(x => !x.parent && x.text === r.it.parent) : null;
  const bagIs = r => { const p = parentOf(r); return p ? p.bag : r.it.bag; };
  const inBag = r => !ui.filter || (ui.filter === '—' ? !bagIs(r) : bagIs(r) === ui.filter);
  const visible = r => inBag(r) && !(ui.hideDone && r.it.done);
  // готовность — по выбранному месту: при «Чемодане» плитки, счётчики разделов и зелёный считают только то, что едет в чемодане (Мария, 15.10.26)
  const mineAll = refs.filter(inBag), done = mineAll.filter(r => r.it.done).length, left = mineAll.length - done;
  const chip = (key, label, color) => {
    const n = key === null ? refs.length : refs.filter(r => key === '—' ? !bagIs(r) : bagIs(r) === key).length;
    const sq = color === undefined ? '' : `<span class="sq${color === null ? ' white' : ''}" style="--g:${color || ''}"></span>`;
    return `<button data-bagf="${key === null ? '' : esc(key)}" aria-pressed="${ui.filter === key}">${sq}${esc(label)} <span class="c num">${n}</span></button>`;
  };
  // группу с подпунктами («Аптечка», «Провода») сворачивает стрелка справа от названия; свёрнутая показывает, сколько внутри собрано (Мария, 15.10.26)
  const foldKey = (si, text) => `${si}:${text}`;
  const foldBtn = r => {
    const kids = r.it.parent ? [] : kidsOf(TRIP.packing.sections[r.si], r.it); if (!kids.length) return '';
    const shut = ui.folded.has(foldKey(r.si, r.it.text));
    return `<button class="fold${shut ? ' shut' : ''}" data-act="fold" aria-expanded="${!shut}" aria-label="${shut ? 'Развернуть' : 'Свернуть'}: ${esc(r.it.text)}">${CHEV}</button>${shut ? `<span class="cap num${kids.every(k => k.done) ? ' kids-full' : ''}">${kids.filter(k => k.done).length}/${kids.length}</span>` : ''}`;
  };
  const row = r => {
    const b = bagOf(r.it.bag);
    const menu = ui.menu === r.id ? `<div class="bagmenu" role="menu">${BAGS.map(x => `<button role="menuitem" data-setbag="${esc(x.name)}"><span class="ls-tag ${x.tag}">${esc(x.name)}</span></button>`).join('')}${b ? '<button role="menuitem" data-setbag="" class="cap">убрать место</button>' : ''}</div>` : '';
    return `<div class="pi${r.it.done ? ' done' : ''}${r.it.parent ? ' child' : ''}${r.it === ui.flash ? ' new' : ''}" data-id="${r.id}">
      <span class="grip w-only" title="Перетащить" aria-hidden="true">${GRIP}</span>
      <button class="box" data-act="done" aria-pressed="${!!r.it.done}" aria-label="${r.it.done ? 'Снять отметку' : 'Отметить'}: ${esc(r.it.text)}">${r.it.done ? '✓' : ''}</button>
      ${ui.edit === r.id ? `<input class="pedit" data-edit="${r.id}" value="${esc(r.it.text)}" aria-label="Название вещи">`
        : `<span class="tx${foldBtn(r) ? ' has-fold' : ''}" data-act="done">${r.it.wardrobe ? wardrobeThumb(r.it.wardrobe) : ''}<span>${esc(r.it.text)}</span>${foldBtn(r)}</span>`}
      ${parentOf(r) ? '<span class="bagwrap"></span>' : `<span class="bagwrap"><button class="ls-tag ${b ? b.tag : 'nobag'}" data-act="bag" aria-haspopup="menu" aria-expanded="${ui.menu === r.id}">${b ? esc(b.name) : 'куда?'}</button>${menu}</span>`}
      <button class="pen w-only" data-act="edit" title="Изменить название" aria-label="Изменить: ${esc(r.it.text)}">${PEN}</button>
      <button class="x w-only" data-act="del" title="Убрать из этой поездки" aria-label="Убрать: ${esc(r.it.text)}">×</button>
    </div>${ui.ask && ui.ask.id === r.id ? askBar(ui.ask) : ''}`;
  };
  const secHTML = TRIP.packing.sections.map((s, si) => {
    const all = refs.filter(r => r.si === si), mine = all.filter(inBag), doneS = mine.filter(r => r.it.done).length, open = !ui.closed.has(s.title);
    let body = '';
    if (open) {
      const base = baseOf(s.title);
      // кнопка — пока базовый список в раздел не загружали: раздел может быть не пустым, если вещь добавили раньше (в т. ч. голосом через инбокс)
      if (base && CAN_WRITE && !s.base && !all.some(r => r.it.bid)) body += `<div class="pstart"><button class="ls-btn" data-loadbase="${si}">Загрузить базовый список</button><span class="cap">${base.items.length} ${plural(base.items.length, 'пункт', 'пункта', 'пунктов')} — лишнее потом уберёшь</span></div>`;
      if (!all.length && s.title === 'Одежда и обувь') body += `<p class="cap pnote">Одежда приходит из гардероба: «🧳 В поездку».</p>`;
      const groups = [...new Set(all.map(r => r.it.group || ''))]; if (!groups.length) groups.push('');
      groups.forEach(gr => {
        // вещи одной подгруппы стоят подряд (гардероб присылает их по номерам, вперемешку), так подзаголовки не повторяются.
        // Одежда (Мария, 12.10.26): подзаголовки только в «Верхе», «Низе» и «Аксессуарах» и только у подгрупп из двух вещей и больше;
        // одиночки — в конце категории под «Другое»; нет ни одной подгруппы из двух — подзаголовков нет совсем. В остальных разделах — всегда.
        const inGroup = all.filter(r => (r.it.group || '') === gr), subs = [...new Set(inGroup.map(r => r.it.sub || ''))];
        const cnt = {}; inGroup.forEach(r => { const k = r.it.sub || ''; cnt[k] = (cnt[k] || 0) + 1; });
        const clothes = s.title === 'Одежда и обувь';
        const useSubs = !clothes || (SUB_GROUPS.has(gr) && subs.some(k => k && cnt[k] >= 2));
        const lone = r => clothes && useSubs && cnt[r.it.sub || ''] < 2;
        const order = r => lone(r) ? subs.length : subs.indexOf(r.it.sub || '');
        let subNow = null, rows = '';
        inGroup.filter(visible).sort((a, b) => order(a) - order(b) || subs.indexOf(a.it.sub || '') - subs.indexOf(b.it.sub || '') || a.ii - b.ii).forEach(r => {
          if (r.it.parent && ui.folded.has(foldKey(si, r.it.parent))) return;
          const head = lone(r) ? 'Другое' : (r.it.sub || '');
          if (useSubs && head !== subNow) { subNow = head; if (head) rows += `<p class="ps">${esc(head)}</p>`; }
          rows += row(r);
        });
        body += `<div class="pgroup" data-si="${si}" data-group="${esc(gr)}">${gr ? `<p class="pg">${esc(gr)}</p>` : ''}${rows}<label class="add w-only"><span aria-hidden="true">+</span><input data-add="${si}" data-group="${esc(gr)}" placeholder="${s.title === 'Одежда и обувь' ? 'добавить: номер или слово из гардероба' : 'добавить вещь'}" aria-label="Добавить вещь" autocomplete="off"></label></div>`;
      });
    }
    const full = mine.length && doneS === mine.length;   // раздел собран целиком — зелёный, как «хорошо» в системе (Мария, 15.10.26)
    return `<section class="psec ls-block${full ? ' full' : ''}"><button class="psec-h" data-sec="${esc(s.title)}" aria-expanded="${open}"><span class="ls-h">${esc(s.title)}</span><span class="cap num">${full ? '✓ <span class="wide-word">собрано · </span>' : ''}${mine.length ? `${doneS} из ${mine.length}` : 'нет'}</span></button>${body}</section>`;
  }).join('');
  return `<div style="display:grid;gap:var(--space-6)">
    <div class="stats3">
      <div class="ls-block ls-stat"><b>${mineAll.length}</b><span class="cap">${plural(mineAll.length, 'вещь', 'вещи', 'вещей')} ${!ui.filter ? 'в списке' : ui.filter === '—' ? 'без места' : '· ' + esc(ui.filter)}</span></div>
      <div class="ls-block ls-stat"><b>${done}</b><span class="cap">собрано</span></div>
      <div class="ls-block ls-stat"><b>${left}</b><span class="cap">осталось</span></div>
    </div>
    <div class="frow"><div class="filters">${chip(null, 'Все')}${BAGS.map(b => chip(b.name, b.name, b.color)).join('')}${chip('—', 'Без места', null)}</div><span class="links"><button class="hidelink" data-hide aria-pressed="${ui.hideDone}">${ui.hideDone ? 'Показать собранное' : 'Скрыть собранное'}</button><button class="hidelink" data-allsec="${anyOpen ? 'close' : 'open'}">${anyOpen ? 'Свернуть всё' : 'Развернуть всё'}</button></span></div>
    <div class="psecs">${secHTML}</div>
  </div>`;
}
// фото вещи — из закрытого репозитория гардероба тем же ключом; нет доступа или фото — картинка просто не показывается
const WARDROBE_API = `https://api.github.com/repos/${OWNER}/wardrobe-data/contents/`;
function wardrobeThumb(n) {
  const file = `thumbs/${String(n).padStart(3, '0')}.jpg`, url = BLOBS['w:' + file];
  if (url === null) return '';
  return `<img class="wthumb" ${typeof url === 'string' ? `src="${url}"` : `data-wfile="${file}"`} alt="" aria-hidden="true">`;
}
function hydrateWardrobe() {
  document.querySelectorAll('img[data-wfile]').forEach(async img => {
    const file = img.dataset.wfile, key = 'w:' + file;
    try {
      if (BLOBS[key] === undefined) {
        BLOBS[key] = (async () => {
          const r = await fetch(WARDROBE_API + file + `?ref=${BRANCH}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.raw' } });
          if (!r.ok) throw new Error(r.status);
          return URL.createObjectURL(await r.blob());
        })();
      }
      const url = await BLOBS[key]; BLOBS[key] = url; img.src = url;
    } catch (e) { BLOBS[key] = null; img.remove(); }
  });
}
// базовый список: добавить пункт / переименовать; при столкновении правок перечитываем файл и повторяем
async function baseOp(op, message) {
  op(BASE); setSave('Сохраняю базовый список…');
  try {
    try { await writeFile('packing-base.json', b64enc(JSON.stringify(BASE, null, 1)), message); }
    catch (e) { if (e.status !== 409 && e.status !== 422) throw e; BASE = await readJSON('packing-base.json'); op(BASE); await writeFile('packing-base.json', b64enc(JSON.stringify(BASE, null, 1)), message); }
    setSave('Базовый список сохранён');
  } catch (e) { setSave('Базовый список не сохранился, проверь интернет', true); }
}
function baseItem(sec, it, old) { const b = baseOf(sec); return b && b.items.find(x => (it.bid && x.bid === it.bid) || x.text === (old ?? it.text)); }
function askBar(a) {
  const q = a.kind === 'add' ? `«${esc(a.text)}» — в базовый список тоже?`
    : a.kind === 'move' ? `«${esc(a.text)}» — ${esc(a.where)}. В базовом списке тоже?`
    : `«${esc(a.old)}» → «${esc(a.text)}» — поменять и в базовом списке?`;
  return `<div class="ask"><span class="cap">${q}</span><div class="ask-b"><button class="ls-btn" data-ask="base">${a.kind === 'add' ? 'В базовый список' : 'И в базовом'}</button><button class="ls-btn" data-ask="once">${a.kind === 'add' ? 'Только эта поездка' : 'Только здесь'}</button></div></div>`;
}
function answerAsk(choice) {
  const ui = packUI(), a = ui.ask; ui.ask = null;
  if (!a || choice !== 'base') return render();
  const r = packRefs().find(x => x.id === a.id); if (!r) return render();
  if (a.kind === 'add') {
    const bid = 'b' + Date.now().toString(36); r.it.bid = bid; changed();
    baseOp(B => { const sec = (B.sections || []).find(x => x.title === r.sec); if (!sec) return;
      if (sec.items.some(x => x.bid === bid)) return;
      let at = -1; sec.items.forEach((x, k) => { if ((x.sub || '') === (r.it.sub || '')) at = k; });
      sec.items.splice(at < 0 ? sec.items.length : at + 1, 0, { bid, text: r.it.text, sub: r.it.sub || '', parent: r.it.parent || '', ...(r.it.group ? { group: r.it.group } : {}) }); }, `базовый список: + «${r.it.text}»`);
  } else if (a.kind === 'move') {
    // в базовом встаёт за тем же соседом, что и в поездке (сосед выше, иначе ниже — из тех, что есть в базовом)
    const items = TRIP.packing.sections[r.si].items, above = items.slice(0, r.ii).reverse().filter(x => x.bid), below = items.slice(r.ii + 1).filter(x => x.bid);
    baseOp(B => { const from = (B.sections || []).find(x => x.title === a.from), to = (B.sections || []).find(x => x.title === a.to); if (!from || !to) return;
      const i = from.items.findIndex(x => x.bid === a.bid); if (i < 0) return;
      const [x] = from.items.splice(i, 1); x.parent = r.it.parent || ''; x.sub = r.it.sub || ''; if (r.it.group) x.group = r.it.group; else delete x.group;
      let at = -1;
      for (const n of above) { const k = to.items.findIndex(y => y.bid === n.bid); if (k >= 0) { at = k + 1; break; } }
      if (at < 0) for (const n of below) { const k = to.items.findIndex(y => y.bid === n.bid); if (k >= 0) { at = k; break; } }
      to.items.splice(at < 0 ? to.items.length : at, 0, x); }, `базовый список: «${a.text}» — ${a.where}`);
  } else {
    baseOp(B => { const sec = (B.sections || []).find(x => x.title === r.sec); const x = sec && sec.items.find(y => (a.bid && y.bid === a.bid) || y.text === a.old); if (x) x.text = a.text; },
      `базовый список: «${a.old}» → «${a.text}»`);
  }
  render();
}
function commitEdit(input) {
  const ui = packUI(), r = packRefs().find(x => x.id === input.dataset.edit); ui.edit = null;
  const v = input.value.trim();
  if (r && v && v !== r.it.text) {
    const old = r.it.text, inBase = baseItem(r.sec, r.it, old);
    r.it.text = v; changed();
    if (inBase) ui.ask = { kind: 'rename', id: r.id, old, text: v, bid: inBase.bid };
  }
  render();
}
function packClick(e) {
  const ui = packUI();
  const wp = e.target.closest('[data-wpick]'); if (wp) { if (CAN_WRITE && WS) wpick(+wp.dataset.wpick, WS.input); return true; }
  const lb = e.target.closest('[data-loadbase]');
  if (lb) { if (!CAN_WRITE) return true; const sec = TRIP.packing.sections[+lb.dataset.loadbase], base = baseOf(sec.title);
    const have = new Set(sec.items.map(i => i.text.trim().toLowerCase()));   // уже добавленное остаётся, повторы из базового не берём
    const add = base.items.filter(i => !have.has(i.text.trim().toLowerCase())).map(i => ({ text: i.text, done: false, bag: null, group: i.group || '', sub: i.sub || '', parent: i.parent || '', bid: i.bid }));
    // без группы — в начало раздела; с группой (бельё в одежде, Мария, 15.10.26) — в конец своей группы, к вещам из гардероба
    sec.items = [...add.filter(i => !i.group), ...sec.items];
    add.filter(i => i.group).forEach(i => { let at = -1; sec.items.forEach((x, k) => { if ((x.group || '') === i.group) at = k; }); sec.items.splice(at < 0 ? sec.items.length : at + 1, 0, i); });
    sec.base = true; changed(); render(); return true; }
  const ak = e.target.closest('[data-ask]'); if (ak) { answerAsk(ak.dataset.ask); return true; }
  if (e.target.closest('[data-edit]')) return true;
  const cp = e.target.closest('[data-copy]');
  if (cp) { const src = TRIPS[cp.dataset.copy]; TRIP.packing.sections = src.packing.sections.map(s => ({ title: s.title, items: s.items.map(i => ({ ...i, done: false })) })); changed(); render(); return true; }
  if (e.target.closest('[data-blank]')) { TRIP.packing.sections = DEFAULT_SECTIONS.map(t => ({ title: t, items: [] })); changed(); render(); return true; }
  const sb = e.target.closest('[data-setbag]');
  if (sb) { if (!CAN_WRITE) return true; const r = packRefs().find(x => x.id === sb.closest('[data-id]').dataset.id); r.it.bag = sb.dataset.setbag || null; ui.menu = null; changed(); render(); return true; }
  const f = e.target.closest('[data-bagf]'); if (f) { const k = f.dataset.bagf || null; ui.filter = ui.filter === k ? null : k; ui.menu = null; render(); return true; }
  if (e.target.closest('[data-hide]')) { ui.hideDone = !ui.hideDone; ui.menu = null; render(); return true; }
  const al = e.target.closest('[data-allsec]');
  if (al) { TRIP.packing.sections.forEach(s => al.dataset.allsec === 'close' ? ui.closed.add(s.title) : ui.closed.delete(s.title)); ui.menu = null; render(); return true; }
  const sh = e.target.closest('[data-sec]'); if (sh) { const k = sh.dataset.sec; ui.closed.has(k) ? ui.closed.delete(k) : ui.closed.add(k); ui.menu = null; render(); return true; }
  const a = e.target.closest('[data-act]');
  if (!a) { if (ui.menu) { ui.menu = null; render(); return true; } return false; }
  if (a.dataset.act === 'fold') {   // сворачивать можно и в режиме «Только смотреть»
    const r = packRefs().find(x => x.id === a.closest('[data-id]').dataset.id), k = `${r.si}:${r.it.text}`;
    ui.folded.has(k) ? ui.folded.delete(k) : ui.folded.add(k); ui.menu = null; render(); return true;
  }
  if (!CAN_WRITE) return true;
  const id = a.closest('[data-id]').dataset.id, r = packRefs().find(x => x.id === id);
  if (a.dataset.act === 'done') { r.it.done = !r.it.done; ui.menu = null; changed(); }
  if (a.dataset.act === 'bag') ui.menu = ui.menu === id ? null : id;
  if (a.dataset.act === 'del') { TRIP.packing.sections[r.si].items.splice(r.ii, 1); ui.menu = null; ui.ask = null; changed(); }   // удаление — только из этой поездки
  if (a.dataset.act === 'edit') { ui.edit = id; ui.menu = null; ui.ask = null; render(); const inp = document.querySelector(`[data-edit="${id}"]`); if (inp) { inp.focus(); inp.select(); } return true; }
  render(); return true;
}
function packAdd(input) {
  const text = input.value.trim(); if (!text) return;
  const si = +input.dataset.add, group = input.dataset.group, items = TRIP.packing.sections[si].items, ui = packUI();
  let at = -1; items.forEach((it, k) => { if ((it.group || '') === group) at = k; });
  const last = items[at];
  items.splice(at + 1, 0, { text, done: false, bag: ui.filter && ui.filter !== '—' ? ui.filter : null, group, sub: last ? last.sub || '' : '', parent: '' });
  ui.ask = baseOf(TRIP.packing.sections[si].title) ? { kind: 'add', id: `${si}.${at + 1}`, text } : null;
  changed(); render();
  const again = [...document.querySelectorAll('[data-add]')].find(x => x.dataset.add === String(si) && x.dataset.group === group); if (again) again.focus();
}

/* ---------- Чемодан: вещь из гардероба поиском в поле «добавить» (Мария, 15.10.26) ---------- */
// В «Одежде и обуви» поле ищет по гардеробу: номер (249) или слова из названия («юбка синяя»). Выбранная вещь встаёт в свою
// категорию так же, как из гардероба («🧳 В поездку»): полное название и номер, поле wardrobe — гардероб видит её выбранной.
// Enter выбирает вещь, только если её выделили стрелками или набран её точный номер; иначе — обычная строка, как раньше.
const WCAT_ORDER = ['Верхняя одежда', 'Верх', 'Низ', 'Платья', 'Спорт', 'Купальники', 'Обувь', 'Аксессуары', 'Бельё'];   // порядок категорий гардероба
let WITEMS = null, WS = null;   // WITEMS: вещи гардероба (null — не грузили, промис — грузятся); WS — открытая подсказка
function loadWardrobe() {
  if (WITEMS === null) WITEMS = (async () => {
    try {
      const r = await fetch(WARDROBE_API + `items.json?ref=${BRANCH}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github.raw' }, cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      return (await r.json()).filter(i => i.core);   // актуальные, как в «В поездку»
    } catch (e) { return []; }   // нет доступа к гардеробу — поле работает как обычное
  })().then(a => (WITEMS = a));
  return Promise.resolve(WITEMS);
}
const wstem = w => w.length > 4 ? w.slice(0, -2) : w.length > 3 ? w.slice(0, -1) : w;   // «юбку», «синий» ловят «Юбка … синяя»
function wfind(q) {
  q = q.trim().toLowerCase().replace(/^#/, ''); if (!q || !Array.isArray(WITEMS)) return [];
  if (/^\d+$/.test(q)) return WITEMS.filter(i => String(i.no).startsWith(q)).sort((a, b) => (String(b.no) === q) - (String(a.no) === q) || a.no - b.no);
  const ws = q.split(/\s+/).map(wstem);
  const hay = i => `${i.name} ${i.cat} ${i.sub || ''} ${i.kind || ''}`.toLowerCase().replace(/ё/g, 'е');
  return WITEMS.filter(i => ws.every(w => hay(i).includes(w.replace(/ё/g, 'е'))))
    .sort((a, b) => b.name.toLowerCase().startsWith(ws[0]) - a.name.toLowerCase().startsWith(ws[0]) || a.no - b.no);
}
function wclose() { if (WS) { const el = WS.input.closest('.add')?.nextElementSibling; if (el && el.classList.contains('wsug')) el.remove(); } WS = null; }
function wsuggest(input) {
  wclose();
  const sec = TRIP.packing.sections[+input.dataset.add];
  if (!sec || sec.title !== 'Одежда и обувь' || !input.value.trim()) return;
  if (!Array.isArray(WITEMS)) { loadWardrobe().then(() => { if (document.activeElement === input) wsuggest(input); }); return; }
  const found = wfind(input.value), list = found.slice(0, 8); if (!list.length) return;
  const inTrip = new Set(sec.items.map(x => x.wardrobe).filter(Boolean));
  const el = document.createElement('div'); el.className = 'wsug'; el.setAttribute('role', 'listbox');
  el.innerHTML = list.map(i => `<button type="button" role="option" aria-selected="false" data-wpick="${i.no}"${inTrip.has(i.no) ? ' disabled' : ''}>
    <span class="wph">${wardrobeThumb(i.no)}</span><span class="wnm"><span>${esc(i.name)} · ${i.no}</span><span class="cap">${esc(i.cat)}${i.sub ? ' · ' + esc(i.sub) : ''}${inTrip.has(i.no) ? ' · уже в списке' : ''}</span></span></button>`).join('')
    + (found.length > list.length ? `<p class="cap wmore">ещё ${found.length - list.length} — допиши цвет или бренд</p>` : '');
  el.addEventListener('mousedown', e => e.preventDefault());   // поле не теряет фокус — клавиатура на телефоне не прячется
  input.closest('.add').after(el); WS = { input }; hydrateWardrobe();
}
function wkey(e) {
  if (!WS || WS.input !== e.target) return false;
  const opts = [...(WS.input.closest('.add').nextElementSibling?.querySelectorAll('[data-wpick]:not(:disabled)') || [])];
  if (e.key === 'Escape') { wclose(); return true; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); if (!opts.length) return true;
    const k = opts.findIndex(o => o.getAttribute('aria-selected') === 'true'), n = e.key === 'ArrowDown' ? (k + 1) % opts.length : (k <= 0 ? opts.length - 1 : k - 1);
    opts.forEach((o, j) => o.setAttribute('aria-selected', String(j === n))); return true;
  }
  if (e.key === 'Enter') {
    const q = WS.input.value.trim().replace(/^#/, '');
    const sel = opts.find(o => o.getAttribute('aria-selected') === 'true') || (/^\d+$/.test(q) && opts.find(o => o.dataset.wpick === q));
    if (sel) { e.preventDefault(); wpick(+sel.dataset.wpick, WS.input); return true; }
    if (/^\d+$/.test(q) && WITEMS.some(i => String(i.no) === q)) { e.preventDefault(); return true; }   // номер уже в списке — строку «249» не добавляем
  }
  return false;
}
function wpick(no, input) {
  const it = Array.isArray(WITEMS) && WITEMS.find(x => x.no === no), si = +input.dataset.add, group = input.dataset.group, sec = TRIP.packing.sections[si], ui = packUI();
  wclose(); if (!it || sec.items.some(x => x.wardrobe === no)) return;
  const line = { text: `${it.name} · ${it.no}`, done: false, bag: ui.filter && ui.filter !== '—' ? ui.filter : null, group: it.cat, sub: it.sub || '', parent: '', wardrobe: it.no };
  // в конец своей категории; категории ещё нет — на её место по порядку гардероба
  const rank = g => { const k = WCAT_ORDER.indexOf(g || ''); return k < 0 ? WCAT_ORDER.length : k; };
  let at = -1; sec.items.forEach((x, k) => { if ((x.group || '') === it.cat) at = k; });
  if (at < 0) sec.items.forEach((x, k) => { if (rank(x.group) < rank(it.cat)) at = k; });
  sec.items.splice(at + 1, 0, line);
  ui.flash = line; ui.ask = null; changed(); render(); setTimeout(() => { if (ui.flash === line) ui.flash = null; }, 1700);
  const again = [...document.querySelectorAll('[data-add]')].find(x => x.dataset.add === String(si) && x.dataset.group === group); if (again) again.focus();
}

/* ---------- Чемодан: перетаскивание за ручку слева (Мария, 15.10.26) ---------- */
// Порядок, перенос в другой раздел и внутрь вещи с подпунктами («Аптечка», «Стирка»). Куда встанет:
// между двумя вещами — к нижней (её подзаголовок; нижняя — подпункт, значит и эта подпункт); на саму вещь с подпунктами — в конец её подпунктов.
// Вещь с подпунктами едет вместе с ними и сама подпунктом не становится. Вещь из гардероба — только внутри своей категории одежды.
let DRAG = null;
const kidsOf = (sec, it) => it.parent ? [] : sec.items.filter(x => x !== it && x.parent === it.text);
function dragStart(e) {
  const g = e.target.closest('.grip'); if (!g || !CAN_WRITE || !TRIP || state.tab !== 'Чемодан' || e.button > 0 || packUI().edit) return;
  const row = g.closest('.pi'), byId = new Map(packRefs().map(r => [r.id, r])), r = byId.get(row.dataset.id); if (!r) return;
  e.preventDefault(); g.setPointerCapture(e.pointerId);
  const ui = packUI(); ui.menu = null; ui.ask = null;
  const kids = kidsOf(TRIP.packing.sections[r.si], r.it);
  const rows = [...document.querySelectorAll('.pi[data-id]')].filter(el => { const x = byId.get(el.dataset.id); return x && (x.it === r.it || kids.includes(x.it)); });
  const line = document.createElement('div'); line.className = 'dropline'; line.hidden = true; document.body.append(line);
  DRAG = { it: r.it, si: r.si, kids, rows, byId, line, pid: e.pointerId, y: e.clientY, y0: e.clientY, s0: scrollY, slot: null };
  rows.forEach(el => el.classList.add('lift')); document.body.classList.add('dragging');
  DRAG.raf = requestAnimationFrame(dragTick);
}
function dragSlot(y) {
  const D = DRAG; let pg = null, best = Infinity;
  document.querySelectorAll('.pgroup[data-si]').forEach(el => { const b = el.getBoundingClientRect(), d = y < b.top ? b.top - y : y > b.bottom ? y - b.bottom : 0; if (d < best) { best = d; pg = el; } });
  if (!pg) return null;
  const si = +pg.dataset.si, gr = pg.dataset.group, sec = TRIP.packing.sections[si];
  if (D.it.wardrobe && (si !== D.si || gr !== (D.it.group || ''))) return null;
  let prev = null, head = null;   // prev — строка выше, head — подзаголовок между ней и следующей
  for (const el of pg.children) {
    if (el.matches('.ps')) { head = el; continue; }
    if (!el.matches('.pi') || D.rows.includes(el)) continue;
    const r = D.byId.get(el.dataset.id), b = el.getBoundingClientRect();
    if (!D.kids.length && !D.it.wardrobe && kidsOf(sec, r.it).length && y > b.top + b.height / 4 && y < b.bottom - b.height / 4) return { si, gr, into: r.it, el };
    if (y < b.top + b.height / 2 && !(D.kids.length && r.it.parent)) {   // вещь с подпунктами не встаёт посреди чужих подпунктов
      if (head && prev && y < head.getBoundingClientRect().top + head.offsetHeight / 2) return { si, gr, after: prev.it, el: prev.el };   // в конец подзаголовка выше
      return { si, gr, before: r.it, el };
    }
    prev = { it: r.it, el }; head = null;
  }
  return prev ? { si, gr, after: prev.it, el: prev.el } : { si, gr, el: pg };
}
function dropAttrs(s, D) {
  if (s.into) return { parent: s.into.text, sub: s.into.sub || '' };
  const nb = s.before || s.after;
  return { parent: !D.kids.length && s.before && s.before.parent ? s.before.parent : '', sub: nb ? nb.sub || '' : '' };
}
function dragMove() {
  const D = DRAG;
  if (!D.rows[0].isConnected) return dragEnd(true);   // список перерисовался (пришли правки) — перенос отменяется
  const dy = D.y - D.y0 + scrollY - D.s0; D.rows.forEach(el => { el.style.transform = `translateY(${dy}px)`; });
  const s = D.slot = dragSlot(D.y);
  D.rows[0].style.paddingLeft = !s ? '' : dropAttrs(s, D).parent ? '22px' : '0px';   // строка сдвигается вправо, если встанет подпунктом
  document.querySelectorAll('.pi.into').forEach(el => el.classList.remove('into'));
  if (!s || s.into) { D.line.hidden = true; if (s) s.el.classList.add('into'); return; }
  const b = s.el.getBoundingClientRect(), y = s.before ? b.top : s.after ? b.bottom : b.top + 8, ind = dropAttrs(s, D).parent ? 44 : 0;
  Object.assign(D.line.style, { top: `${y - 1}px`, left: `${b.left + ind}px`, width: `${b.width - ind}px` }); D.line.hidden = false;
}
function dragTick() {   // у края экрана список прокручивается сам
  if (!DRAG) return;
  const y = DRAG.y, edge = 70, v = y < edge ? -(edge - y) / 5 : y > innerHeight - edge ? (y - innerHeight + edge) / 5 : 0;
  if (v) scrollBy(0, v);
  dragMove(); if (DRAG) DRAG.raf = requestAnimationFrame(dragTick);
}
function dragEnd(cancel) {
  const D = DRAG; if (!D) return; DRAG = null;
  cancelAnimationFrame(D.raf); D.line.remove(); document.body.classList.remove('dragging');
  const s = D.slot, src = TRIP.packing.sections[D.si], dst = s && TRIP.packing.sections[s.si];
  if (cancel || !s || !src.items.includes(D.it)) return render();
  const block = [D.it, ...D.kids], was = JSON.stringify([src.items, dst.items]), old = { parent: D.it.parent || '', sub: D.it.sub || '' };
  const a = dropAttrs(s, D), ui = packUI();
  block.forEach(x => src.items.splice(src.items.indexOf(x), 1));
  let at;
  if (s.into) at = Math.max(...dst.items.map((x, k) => x === s.into || x.parent === s.into.text ? k : -1)) + 1;
  else if (s.before) at = dst.items.indexOf(s.before);
  else if (s.after) at = Math.max(...dst.items.map((x, k) => x === s.after || (!s.after.parent && x.parent === s.after.text) ? k : -1)) + 1;
  else { at = dst.items.length; dst.items.forEach((x, k) => { if ((x.group || '') === s.gr) at = k + 1; }); }
  block.forEach(x => { x.group = s.gr; if (!x.wardrobe) x.sub = a.sub; });
  D.it.parent = a.parent;
  dst.items.splice(at, 0, ...block);
  if (JSON.stringify([src.items, dst.items]) === was) return render();
  const inBase = baseItem(src.title, D.it);
  if (inBase && (a.parent !== old.parent || src !== dst || a.sub !== old.sub))
    ui.ask = { kind: 'move', id: `${s.si}.${at}`, text: D.it.text, bid: inBase.bid, from: src.title, to: dst.title, parent: a.parent,
      where: a.parent ? `в группу «${a.parent}»` : old.parent ? `из группы «${old.parent}»` : src !== dst ? `в раздел «${dst.title}»` : a.sub ? `под заголовок «${a.sub}»` : 'без заголовка' };
  changed(); render();
}

/* ---------- Места и еда: один список, «были» и «понравилось», траты привязаны по place ---------- */
const LISTUI = {};
function listTab(kind) {
  const arr = TRIP[kind], ui = (LISTUI[TRIP.id + kind] = LISTUI[TRIP.id + kind] || { filter: null, menu: null, rate: null, del: null });
  const word = kind === 'food' ? ['заведение', 'заведения', 'заведений'] : ['место', 'места', 'мест'];
  const exOf = name => EXP.filter(e => e.place === name);
  const sumOf = name => exOf(name).reduce((s, e) => s + e.amount, 0);
  const visited = arr.filter(x => x.visited).length, spent = arr.reduce((s, x) => s + sumOf(x.name), 0);
  const lists = (TRIP.lists || []).filter(l => l.kind === kind);
  const shown = arr.map((x, i) => ({ x, i })).filter(({ x }) => !ui.filter || (ui.filter === 'yes' ? x.visited : !x.visited));
  const rated = arr.filter(x => x.rating).sort((a, b) => b.rating - a.rating).slice(0, 5);   // «Лучшие» — и в еде, и в местах
  const best = rated.length ? [] : kind === 'food' ? arr.filter(x => x.rank).sort((a, b) => a.rank - b.rank) : [];
  const row = ({ x, i }) => {
    const ex = exOf(x.name), sum = ex.reduce((s, e) => s + e.amount, 0);
    const caption = x.address ? esc(x.address) : esc(x.city || ''); // в адресе Яндекса город уже есть
    const menu = ui.menu === i ? `<div class="costmenu">${ex.map(e => `<div><span>${esc(e.name)}</span><span class="num">${fmt(e.amount)}</span></div>`).join('')}</div>` : '';
    return `<div class="pl-row${x.visited ? '' : ' not'}" data-i="${i}">
      <button class="box" data-lact="visited" aria-pressed="${!!x.visited}" aria-label="${x.visited ? 'Были' : 'Отметить «были»'}: ${esc(x.name)}">${x.visited ? '✓' : ''}</button>
      <span class="nm"><span>${esc(x.name)}${x.rank ? ` <span class="cap">· ${x.rank}-е место</span>` : ''}</span>${caption ? `<span class="linked">${caption}</span>` : ''}${x.oid ? `<a href="https://yandex.ru/maps/org/${esc(x.oid)}" target="_blank" rel="noopener">в Яндекс Картах</a>` : ''}</span>
      <span class="cost">${sum ? `<button data-lact="cost" title="${esc(ex.map(e => e.name + ' — ' + fmt(e.amount)).join('\n'))}">${fmt(sum)}</button>${menu}` : ''}</span>
      ${x.visited ? `<button class="rate${x.rating ? '' : ' empty'}" data-lact="rate" aria-label="Оценка: ${esc(x.name)}">${x.rating || 'оценить'}</button>` : '<span></span>'}
      <button class="ldel w-only${ui.del === i ? ' sure' : ''}" data-lact="del" title="Убрать" aria-label="Убрать: ${esc(x.name)}">${ui.del === i ? 'убрать?' : '×'}</button>
    </div>${ui.rate === i ? `<div class="rater" data-i="${i}"><span class="cap">Оценка из 10</span><div class="rate-b">${Array.from({ length: 10 }, (_, k) =>
      `<button data-lact="setrate" data-v="${k + 1}" aria-pressed="${x.rating === k + 1}">${k + 1}</button>`).join('')}<button class="later" data-lact="later">${x.rating ? 'убрать оценку' : 'позже'}</button></div></div>` : ''}`;
  };
  const chip = (key, label, n) => `<button data-lfilter="${key || ''}" aria-pressed="${ui.filter === key}">${label} <span class="c num">${n}</span></button>`;
  return `<div style="display:grid;gap:var(--space-6)">
    <div class="stats3">
      <div class="ls-block ls-stat"><b>${arr.length}</b><span class="cap">${plural(arr.length, ...word)} в списке</span></div>
      <div class="ls-block ls-stat"><b>${visited}</b><span class="cap">были</span></div>
      <div class="ls-block ls-stat"><b>${spent ? fmt(spent) : '—'}</b><span class="cap">${kind === 'food' ? 'на еду в этих местах' : 'на места вместе с дорогой и едой там'}</span></div>
    </div>
    ${rated.length ? `<section class="section"><h2 class="ls-h">Лучшие</h2><div class="podium3">${rated.map(r => `<div class="ls-block pod"><span class="pl">${r.rating}</span><b>${esc(r.name)}</b><span class="cap">${sumOf(r.name) ? fmt(sumOf(r.name)) : ''}</span></div>`).join('')}</div></section>` : ''}
    ${best.length ? `<section class="section"><h2 class="ls-h">Лучшие рестораны</h2><div class="podium3">${best.map(r => `<div class="ls-block pod"><span class="pl">${r.rank}</span><b>${esc(r.name)}</b><span class="cap">${sumOf(r.name) ? fmt(sumOf(r.name)) : ''}</span></div>`).join('')}</div></section>` : ''}
    <section class="section">
      ${lists.length ? `<p class="cap lists" style="margin:0">Из Яндекс Карт: ${lists.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>`).join(' ')}</p>` : ''}
      <div class="filters">${chip(null, 'Все', arr.length)}${chip('yes', 'Были', visited)}${chip('no', 'Не были', arr.length - visited)}</div>
      <div class="ls-block">${shown.map(row).join('') || '<p class="cap" style="margin:0">Здесь пусто.</p>'}
        <label class="add w-only"><span aria-hidden="true">+</span><input data-ladd="${kind}" placeholder="${kind === 'food' ? 'добавить заведение' : 'добавить место'}" aria-label="Добавить"></label></div>
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
  if (a.dataset.lact === 'del') {   // с подтверждением: к месту бывают привязаны траты
    if (ui.del !== i) { ui.del = i; ui.rate = null; ui.menu = null; render(); return true; }
    TRIP[kind].splice(i, 1); ui.del = null; ui.rate = null; ui.menu = null; changed(); render(); return true;
  }
  ui.del = null;
  if (a.dataset.lact === 'visited') { x.visited = !x.visited; if (!x.visited) delete x.rating; ui.rate = x.visited && !x.rating ? i : null; }   // сняли «были» — без оценки
  if (a.dataset.lact === 'rate') { ui.rate = ui.rate === i ? null : i; render(); return true; }
  if (a.dataset.lact === 'setrate') { x.rating = +a.dataset.v; ui.rate = null; }
  if (a.dataset.lact === 'later') { if (x.rating) delete x.rating; ui.rate = null; }
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
  const nt = e.target.closest('[data-newtrip]'); if (nt) { NEW_FORM = nt.dataset.newtrip === 'open'; TYPE_MENU = null; catalogView(); if (NEW_FORM) document.querySelector('#newtrip [name=title]').focus(); return; }
  const tm = e.target.closest('[data-typemenu]'); if (tm) { TYPE_MENU = TYPE_MENU === tm.dataset.typemenu ? null : tm.dataset.typemenu; catalogView(); return; }
  const st = e.target.closest('[data-settype]'); if (st) { setType(st.dataset.id, st.dataset.settype); return; }
  if (!TRIP && TYPE_MENU) { TYPE_MENU = null; catalogView(); return; }
  if (e.target.closest('#logout')) { LS.del('trips-token'); LS.del('trips-ro'); TOKEN = null; location.hash = ''; loginView(); return; }
  const tb = e.target.closest('[data-tab]'); if (tb) { history.replaceState(null, '', `#/trip/${TRIP.id}/${encodeURIComponent(tb.dataset.tab)}`); state.tab = tb.dataset.tab; render(); return; }
  if (!TRIP) return;
  if (state.tab === 'Чемодан' && packClick(e)) return;
  if ((state.tab === 'Места' || state.tab === 'Еда') && listClick(e)) return;
  if (state.tab === 'Фото' || state.tab === 'Обзор') {   // фото из ленты «Обзора» открываются тем же просмотром
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
root.addEventListener('pointerdown', dragStart);
root.addEventListener('input', e => { if (TRIP && state.tab === 'Чемодан' && e.target.matches('[data-add]')) wsuggest(e.target); });
root.addEventListener('focusin', e => { if (TRIP && state.tab === 'Чемодан' && e.target.matches('[data-add]') && TRIP.packing.sections[+e.target.dataset.add]?.title === 'Одежда и обувь') loadWardrobe(); });
document.addEventListener('pointermove', e => { if (DRAG && e.pointerId === DRAG.pid) DRAG.y = e.clientY; });
document.addEventListener('pointerup', e => { if (DRAG && e.pointerId === DRAG.pid) { DRAG.y = e.clientY; dragMove(); dragEnd(false); } });
document.addEventListener('pointercancel', e => { if (DRAG && e.pointerId === DRAG.pid) dragEnd(true); });
root.addEventListener('focusout', e => {
  if (e.target.matches && e.target.matches('[data-edit]') && packUI().edit === e.target.dataset.edit) commitEdit(e.target);
  if (WS && WS.input === e.target) { const t = e.target; setTimeout(() => { if (WS && WS.input === t && document.activeElement !== t) wclose(); }, 250); }
});
root.addEventListener('keydown', e => {
  if (e.target.matches && e.target.matches('[data-add]') && wkey(e)) return;
  if (e.key === 'Escape' && e.target.matches && e.target.matches('[data-edit]')) { packUI().edit = null; render(); return; }
  if (e.key !== 'Enter') { const pk = e.target.closest('[data-pick]'); if (pk && e.key === ' ') { e.preventDefault(); pk.click(); } return; }
  const t = e.target;
  if (t.matches('[data-pick]')) { e.preventDefault(); t.click(); return; }
  if (!CAN_WRITE) return;
  if (t.matches('[data-add]')) { e.preventDefault(); packAdd(t); return; }
  if (t.matches('[data-edit]')) { e.preventDefault(); commitEdit(t); return; }
  if (t.matches('[data-ladd]')) { e.preventDefault(); const v = t.value.trim(); if (!v) return; TRIP[t.dataset.ladd].push({ name: v, city: null, visited: false, liked: false }); changed(); render(); const n = document.querySelector(`[data-ladd="${t.dataset.ladd}"]`); if (n) n.focus(); return; }
  if (t.matches('[data-note]')) { e.preventDefault(); const v = t.value.trim(); if (!v) return; TRIP.notes.push({ section: null, text: v }); changed(); render(); const n = document.querySelector('[data-note]'); if (n) n.focus(); }
});
root.addEventListener('submit', e => { if (e.target.id === 'newtrip') { e.preventDefault(); createTrip(e.target); } });
root.addEventListener('change', e => {
  if (e.target.id === 'nt-nodates') { document.getElementById('nt-dates').hidden = e.target.checked; document.getElementById('nt-month').hidden = !e.target.checked; return; } if ((e.target.id === 'phfile' || e.target.id === 'phfile2') && e.target.files.length && CAN_WRITE) addPhotos([...e.target.files]); });
document.addEventListener('keydown', e => {
  if (!TRIP || (state.tab !== 'Фото' && state.tab !== 'Обзор') || phUI().open === null || e.target.id === 'phcap') return;
  const map = { Escape: 'close', ArrowLeft: 'prev', ArrowRight: 'next' }, b = map[e.key] && document.querySelector(`[data-lb="${map[e.key]}"]`); if (b) b.click();
});

// свежая версия: GitHub Pages разрешает браузеру 10 минут держать старую страницу. Сверяем номер версии
// в свежем index.html с загруженным и при расхождении перезагружаем — один раз на версию (как в «Уборке»)
const MY_V = (document.querySelector('script[src*="app.js?v="]') || { src: '' }).src.split('v=')[1] || '';
async function checkFresh() {
  try {
    const html = await (await fetch(`${location.pathname}?fresh=${Date.now()}`, { cache: 'no-store' })).text();
    const v = (html.match(/app\.js\?v=([\w-]+)/) || [])[1];
    if (!v || !MY_V || v === MY_V) return;
    if (sessionStorage.getItem('trips-reloaded') === v) return;
    sessionStorage.setItem('trips-reloaded', v); location.reload();
  } catch (e) { /* без сети — в другой раз */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkFresh(); });
checkFresh();
boot();
