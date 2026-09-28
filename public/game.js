'use strict';
/* BUILD & BETRAY — client */
const $ = s => document.querySelector(s);
const screens = ['#menu', '#lobby', '#game'];
const showScreen = id => screens.forEach(s => $(s).classList.toggle('hidden', s !== id));
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';

/* ---------------- state ---------------- */
let ws = null, myId = null, isHost = false;
let map = null, role = 'crew', boot = '', mates = [];
let roster = {};                 // id -> {name,color}
let state = null;                // latest snapshot
const P = {};                    // render positions
let pings = [];
let notebook = [];
let mini = null, pendingTask = null;
let meetingOpen = false, meetingId = -1, lastMeeting = null;
const keys = {};
let lastInput = '0,0';

const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const myAlive = () => { const p = state && state.players.find(q => q.id === myId); return p ? !!p.a : true; };

/* ---------------- connection ---------------- */
function connect(then) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = then;
  ws.onmessage = e => onMsg(JSON.parse(e.data));
  ws.onclose = () => { menuMsg('Disconnected from the server.'); showScreen('#menu'); hideOverlays(); };
}
function menuMsg(t) { $('#menuMsg').textContent = t || ''; }
function joinRoom(create) {
  const name = $('#inName').value.trim() || 'Builder';
  const room = $('#inRoom').value.trim();
  if (!create && !room) return menuMsg('Enter a room code first.');
  localStorage.setItem('bb_name', name);
  menuMsg('');
  const go = () => send({ t: 'join', name, room, create });
  if (ws && ws.readyState === 1) go(); else connect(go);
}
$('#inName').value = localStorage.getItem('bb_name') || '';
$('#btnCreate').onclick = () => joinRoom(true);
$('#btnJoin').onclick = () => joinRoom(false);
$('#inRoom').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(false); });
$('#btnStart').onclick = () => send({ t: 'start' });
$('#btnBack').onclick = () => send({ t: 'toLobby' });

/* ---------------- messages ---------------- */
function onMsg(m) {
  switch (m.t) {
    case 'error': menuMsg(m.text); break;
    case 'joined': myId = m.id; break;
    case 'host': isHost = true; $('#btnBack').classList.remove('hidden'); $('#overWait').classList.add('hidden'); break;
    case 'lobby': renderLobby(m); break;
    case 'start': startGame(m); break;
    case 'state': state = m; onState(); break;
    case 'toast': toast(m.text); break;
    case 'alert': showAlert(m.text); break;
    case 'ping': pings.push({ x: m.x, y: m.y, t: 0 }); break;
    case 'clue': notebook.push(m); toast('📓 New clue added to your notebook (N)'); renderNotebook(); break;
    case 'taskOk': if (pendingTask === m.station) openMini(m.station); break;
    case 'meeting': onMeeting(m); break;
    case 'chat': addChat(m); break;
    case 'meetingEnd': meetingOpen = false; $('#meeting').classList.add('hidden'); break;
    case 'over': onOver(m); break;
  }
}

function renderLobby(m) {
  showScreen('#lobby'); hideOverlays();
  state = null; for (const k in P) delete P[k];
  $('#lobbyCode').textContent = m.room;
  const me = m.players.find(p => p.id === myId);
  isHost = !!(me && me.host);
  const ul = $('#lobbyList'); ul.innerHTML = '';
  for (const p of m.players) {
    const li = document.createElement('li');
    const d = document.createElement('span'); d.className = 'dot'; d.style.background = p.color;
    const n = document.createElement('span'); n.textContent = p.name + (p.id === myId ? ' (you)' : '');
    li.append(d, n);
    if (p.host) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'host'; li.append(b); }
    ul.append(li);
  }
  $('#btnStart').classList.toggle('hidden', !isHost);
  $('#btnStart').disabled = m.players.length < m.min;
  $('#lobbyHint').textContent = m.players.length < m.min
    ? `Waiting for players… (need at least ${m.min})`
    : (isHost ? 'Ready when you are.' : 'Waiting for the host to start.');
}

function startGame(m) {
  map = m.map; role = m.role; boot = m.boot; mates = m.mates; myId = m.meId;
  roster = {}; m.players.forEach(p => roster[p.id] = p);
  notebook = []; pings = []; state = null; for (const k in P) delete P[k];
  pendingTask = null; mini = null; meetingOpen = false; lastInput = '0,0';
  hideOverlays();
  showScreen('#game');
  buildHud();
  const sab = role === 'saboteur';
  $('#revTitle').textContent = sab ? 'You are a SABOTEUR' : 'You are a BUILDER';
  $('#revTitle').style.color = sab ? '#ff8b7d' : '#8fd6a0';
  $('#revSub').textContent = sab
    ? `Wreck the settlement without being caught.${mates.length ? ' Your partner: ' + mates.join(', ') + '.' : ''} Your boots: ${boot}.`
    : `Gather, build, and find the saboteur. Your boots: ${boot}.`;
  $('#reveal').classList.remove('hidden');
}
$('#reveal').onclick = () => $('#reveal').classList.add('hidden');

function hideOverlays() {
  ['#reveal', '#mini', '#notebook', '#meeting', '#over'].forEach(s => $(s).classList.add('hidden'));
  mini = null; meetingOpen = false;
}

/* ---------------- HUD ---------------- */
function buildHud() {
  $('#roleChip').className = role === 'saboteur' ? 'sab' : '';
  $('#roleChip').innerHTML = role === 'saboteur'
    ? `Saboteur <small>· ${mates.length ? 'partner: ' + mates.join(', ') : 'working alone'}</small>`
    : `Builder <small>· boots: ${boot}</small>`;
  const box = $('#sabBtns'); box.innerHTML = '';
  if (role !== 'saboteur') return;
  const defs = [
    ['damage', 'Q', 'Sabotage building'], ['steal', 'X', 'Steal'],
    ['fire', '1', 'Fire'], ['surge', '2', 'Power surge'], ['lights', '3', 'Lights out'],
  ];
  for (const [k, key, label] of defs) {
    const b = document.createElement('button');
    b.dataset.k = k; b.dataset.label = `[${key}] ${label}`; b.textContent = b.dataset.label;
    b.onclick = () => send({ t: 'sabotage', kind: k });
    box.append(b);
  }
}

function onState() {
  // sync render positions
  const seen = new Set();
  for (const p of state.players) {
    seen.add(p.id);
    const r = P[p.id] || (P[p.id] = { x: p.x, y: p.y, fx: 1 });
    if (Math.abs(p.x - r.tx) > 0.5) r.fx = p.x > r.tx ? 1 : -1;
    r.tx = p.x; r.ty = p.y; r.a = p.a; r.w = p.w; r.seen = true;
  }
  for (const id in P) if (!seen.has(+id)) P[id].seen = false;

  $('#integFill').style.width = state.integrity + '%';
  $('#integFill').style.background = state.integrity > 60 ? 'var(--pine)' : state.integrity > 30 ? 'var(--brass)' : 'var(--ember)';
  $('#integVal').textContent = state.integrity;
  $('#stock').textContent = `🪵 ${state.stock.wood}   🪨 ${state.stock.stone}   🌾 ${state.stock.food}`;
  $('#builds').innerHTML = map.plots.map(pl => {
    const s = state.steps[pl.id];
    return `<span class="chip ${s >= 3 ? 'done' : ''} ${state.damaged[pl.id] ? 'dmg' : ''}" title="${pl.name}">${pl.icon} ${s}/3</span>`;
  }).join('');

  const cb = $('#crisisbar');
  if (state.crisis) {
    cb.classList.remove('hidden');
    cb.innerHTML = `<b>${state.crisis.label}</b> · ${Math.ceil(state.crisis.left)}s left<div class="cbar"><i style="width:${Math.min(100, state.crisis.progress / 4 * 100)}%"></i></div>`;
  } else if (state.lights) {
    cb.classList.remove('hidden'); cb.innerHTML = '<b>💡 Lights out</b> · fix it at the Generator';
  } else cb.classList.add('hidden');

  if (role === 'saboteur' && state.cd) {
    const map2 = { damage: state.cd.damage, steal: state.cd.steal, fire: state.cd.mal, surge: state.cd.mal, lights: state.cd.mal };
    document.querySelectorAll('#sabBtns button').forEach(b => {
      const cd = map2[b.dataset.k];
      b.textContent = cd > 0.5 ? `${b.dataset.label} (${Math.ceil(cd)}s)` : b.dataset.label;
      b.disabled = cd > 0.5;
    });
  }
}

function toast(text) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = text;
  $('#toasts').append(d);
  setTimeout(() => d.remove(), 4600);
  while ($('#toasts').children.length > 5) $('#toasts').firstChild.remove();
}
let alertTimer = null;
function showAlert(text) {
  const a = $('#alertbar'); a.textContent = text; a.classList.remove('hidden');
  clearTimeout(alertTimer); alertTimer = setTimeout(() => a.classList.add('hidden'), 6000);
}

/* ---------------- notebook ---------------- */
function noteEl(n, withShare) {
  const d = document.createElement('div'); d.className = 'note';
  const b = document.createElement('b'); b.textContent = n.title;
  d.append(b, document.createTextNode('\n' + n.text));
  if (withShare) {
    const btn = document.createElement('button'); btn.textContent = 'Share in chat';
    btn.onclick = () => send({ t: 'share', id: n.id });
    d.append(document.createElement('br'), btn);
  }
  return d;
}
function renderNotebook() {
  const l = $('#nbList'); l.innerHTML = '';
  if (!notebook.length) l.textContent = 'No clues yet. Inspect sites with F.';
  notebook.slice().reverse().forEach(n => l.append(noteEl(n, false)));
  const ml = $('#mtNoteList'); ml.innerHTML = '';
  if (!notebook.length) ml.textContent = 'You have no clues.';
  notebook.slice().reverse().forEach(n => ml.append(noteEl(n, true)));
}
function toggleNotebook() {
  if (meetingOpen || mini) return;
  renderNotebook();
  $('#notebook').classList.toggle('hidden');
}

/* ---------------- input ---------------- */
function sendInput() {
  let dx = 0, dy = 0;
  if (!mini && !meetingOpen && !overlayBlocking()) {
    if (keys.a || keys.arrowleft) dx--;
    if (keys.d || keys.arrowright) dx++;
    if (keys.w || keys.arrowup) dy--;
    if (keys.s || keys.arrowdown) dy++;
  }
  const s = dx + ',' + dy;
  if (s !== lastInput) { lastInput = s; send({ t: 'input', dx, dy }); }
}
const overlayBlocking = () => !$('#reveal').classList.contains('hidden') || !$('#over').classList.contains('hidden');

function nd(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
const RES_LABEL = { forest: 'Chop wood', quarry: 'Mine stone', farm: 'Harvest food' };

function findInteract() {
  const me = P[myId];
  if (!state || !map || !me || !myAlive()) return null;
  const out = { lines: [], e: null };
  const cr = state.crisis;
  let hold = null;
  if (cr) for (const pt of cr.points) if (nd(me, pt) < 75) {
    hold = cr.type === 'fire' ? 'Hold E to put out the fire' : 'Hold E on the pylon (a partner must hold the other one!)';
  }
  if (state.lights && nd(me, map.stations.generator) < 75) hold = 'Hold E to restore the lights';
  if (hold) { out.e = { type: 'hold' }; out.lines.push('[E] ' + hold); }

  for (const k of ['forest', 'quarry', 'farm']) {
    if (!out.e && nd(me, map.stations[k]) <= 80) { out.e = { type: 'task', station: k }; out.lines.push('[E] ' + RES_LABEL[k]); }
  }
  let site = false;
  for (const pl of map.plots) if (nd(me, pl) <= 80) {
    site = true;
    const s = state.steps[pl.id];
    if (s < 3 && !out.e) {
      const cost = Object.entries(pl.step).map(([a, b]) => b + ' ' + a).join(', ');
      out.e = { type: 'task', station: 'plot:' + pl.id };
      out.lines.push(`[E] Build ${pl.name} — step ${s + 1}/3 (${cost})`);
    }
  }
  if (nd(me, map.stations.store) <= 100) { site = true; out.lines.push('[F] Read the ledger'); }
  if (nd(me, map.stations.bell) <= 90 && state.bell && !out.e) { out.e = { type: 'bell' }; out.lines.push('[E] Ring the bell — call an emergency meeting'); }
  if (site) out.lines.push('[F] Inspect   [R] Report sabotage');
  return out;
}

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if ($('#game').classList.contains('hidden')) return;
  if (mini) { miniKey(e, k); return; }
  if (meetingOpen) return;
  if (k === 'n') { toggleNotebook(); return; }
  if (!$('#notebook').classList.contains('hidden') && k === 'escape') { toggleNotebook(); return; }
  if (overlayBlocking()) return;
  if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) { keys[k] = true; e.preventDefault(); sendInput(); return; }
  if (e.repeat) return;
  if (k === 'e') {
    send({ t: 'hold', on: true });
    const it = findInteract();
    if (it && it.e) {
      if (it.e.type === 'task') { pendingTask = it.e.station; send({ t: 'taskStart', station: it.e.station }); }
      else if (it.e.type === 'bell') send({ t: 'bell' });
    }
  }
  else if (k === 'f') send({ t: 'inspect' });
  else if (k === 'r') send({ t: 'report' });
  else if (role === 'saboteur') {
    const m = { q: 'damage', x: 'steal', '1': 'fire', '2': 'surge', '3': 'lights' }[k];
    if (m) send({ t: 'sabotage', kind: m });
  }
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  keys[k] = false;
  if (k === 'e') send({ t: 'hold', on: false });
  sendInput();
});
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; send({ t: 'hold', on: false }); sendInput(); });

/* ---------------- mini-games ---------------- */
const MINI_TITLE = { chop: 'Chop the tree', mine: 'Mine the stone', harvest: 'Harvest the crops', hammer: 'Hammer it together' };
const MINI_HELP = {
  chop: 'Press Space (or click) when the marker is in the green zone. Land 3 hits.',
  mine: 'Stop the cursor inside the green zone. Three rounds, the zone shrinks.',
  harvest: 'Click the crops in order, 1 to 5. A wrong click starts you over.',
  hammer: 'Repeat the arrow sequence with arrow keys or WASD.',
};
function openMini(station) {
  pendingTask = null;
  const kind = station === 'forest' ? 'chop' : station === 'quarry' ? 'mine' : station === 'farm' ? 'harvest' : 'hammer';
  mini = { kind, station, t: 0, flash: 0, flashOk: true };
  if (kind === 'chop') Object.assign(mini, { x: 20, dir: 1, speed: 260, hits: 0 });
  if (kind === 'mine') { Object.assign(mini, { u: 0, dir: 1, round: 0 }); newZone(); }
  if (kind === 'harvest') {
    const nodes = [];
    while (nodes.length < 5) {
      const n = { x: rnd(40, 400), y: rnd(40, 180) };
      if (nodes.every(o => Math.hypot(o.x - n.x, o.y - n.y) > 62)) nodes.push(n);
    }
    Object.assign(mini, { nodes, next: 1 });
  }
  if (kind === 'hammer') Object.assign(mini, { seq: Array.from({ length: 6 }, () => Math.floor(Math.random() * 4)), i: 0 });
  $('#miniTitle').textContent = MINI_TITLE[kind];
  $('#miniHelp').textContent = MINI_HELP[kind];
  $('#mini').classList.remove('hidden');
  lastInput = ''; sendInput();
}
const rnd = (a, b) => a + Math.random() * (b - a);
function newZone() { const w = 0.22 - mini.round * 0.05; mini.zw = w; mini.zs = rnd(0.08, 0.92 - w); }
function closeMini(cancel) {
  if (!mini) return;
  if (cancel) send({ t: 'taskCancel' });
  mini = null; $('#mini').classList.add('hidden');
}
function miniWin() { const s = mini.station; closeMini(false); send({ t: 'taskDone', station: s }); }
function miniFlash(ok) { mini.flash = 0.25; mini.flashOk = ok; }

function miniKey(e, k) {
  if (k === 'escape') { closeMini(true); return; }
  if (mini.kind === 'chop' || mini.kind === 'mine') {
    if (k === ' ' || k === 'enter') { e.preventDefault(); if (!e.repeat) miniAction(); }
  } else if (mini.kind === 'hammer') {
    const d = { arrowleft: 0, a: 0, arrowup: 1, w: 1, arrowright: 2, d: 2, arrowdown: 3, s: 3 }[k];
    if (d === undefined) return;
    e.preventDefault();
    if (d === mini.seq[mini.i]) { mini.i++; miniFlash(true); if (mini.i >= mini.seq.length) miniWin(); }
    else { mini.i = 0; miniFlash(false); }
  }
}
function miniAction() {
  if (mini.kind === 'chop') {
    if (Math.abs(mini.x - 220) <= 32) { mini.hits++; mini.speed += 50; miniFlash(true); if (mini.hits >= 3) miniWin(); }
    else miniFlash(false);
  } else if (mini.kind === 'mine') {
    if (mini.u >= mini.zs && mini.u <= mini.zs + mini.zw) {
      mini.round++; miniFlash(true);
      if (mini.round >= 3) miniWin(); else newZone();
    } else miniFlash(false);
  }
}
$('#mcv').addEventListener('mousedown', e => {
  if (!mini) return;
  const c = $('#mcv'), r = c.getBoundingClientRect();
  const x = (e.clientX - r.left) * c.width / r.width, y = (e.clientY - r.top) * c.height / r.height;
  if (mini.kind === 'harvest') {
    const hit = mini.nodes.findIndex(o => Math.hypot(o.x - x, o.y - y) < 24);
    if (hit < 0) return;
    if (hit === mini.next - 1) { mini.next++; miniFlash(true); if (mini.next > 5) miniWin(); }
    else { mini.next = 1; miniFlash(false); }
  } else miniAction();
});

function updateMini(dt) {
  if (!mini) return;
  mini.t += dt; mini.flash = Math.max(0, mini.flash - dt);
  if (mini.kind === 'chop') {
    mini.x += mini.dir * mini.speed * dt;
    if (mini.x > 420) { mini.x = 420; mini.dir = -1; } if (mini.x < 20) { mini.x = 20; mini.dir = 1; }
  }
  if (mini.kind === 'mine') {
    mini.u += mini.dir * (0.8 + mini.round * 0.25) * dt;
    if (mini.u > 1) { mini.u = 1; mini.dir = -1; } if (mini.u < 0) { mini.u = 0; mini.dir = 1; }
  }
  if (!mini) return;
  const c = $('#mcv'), g = c.getContext('2d');
  g.clearRect(0, 0, 440, 220);
  g.fillStyle = mini.flash > 0 ? (mini.flashOk ? '#1d3a2a' : '#4a2320') : '#121a22';
  g.fillRect(0, 0, 440, 220);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (mini.kind === 'chop') {
    g.fillStyle = '#2f3d4d'; g.fillRect(20, 105, 400, 20);
    g.fillStyle = '#4e9d62'; g.fillRect(188, 100, 64, 30);
    g.fillStyle = '#ecdcb8'; g.beginPath(); g.arc(mini.x, 115, 13, 0, 7); g.fill();
    g.font = `40px ${EMOJI_FONT}`; g.fillStyle = '#fff'; g.fillText('🌲', 220, 50);
    g.font = '16px sans-serif'; g.fillText('●'.repeat(mini.hits) + '○'.repeat(3 - mini.hits), 220, 180);
  } else if (mini.kind === 'mine') {
    g.fillStyle = '#2f3d4d'; g.fillRect(20, 105, 400, 20);
    g.fillStyle = '#4e9d62'; g.fillRect(20 + mini.zs * 400, 100, mini.zw * 400, 30);
    g.fillStyle = '#ecdcb8'; g.fillRect(20 + mini.u * 400 - 3, 92, 6, 46);
    g.font = `40px ${EMOJI_FONT}`; g.fillStyle = '#fff'; g.fillText('🪨', 220, 50);
    g.font = '16px sans-serif'; g.fillText('●'.repeat(mini.round) + '○'.repeat(3 - mini.round), 220, 180);
  } else if (mini.kind === 'harvest') {
    mini.nodes.forEach((n, i) => {
      g.fillStyle = i < mini.next - 1 ? '#4e9d62' : '#d8a13b';
      g.beginPath(); g.arc(n.x, n.y, 22, 0, 7); g.fill();
      g.fillStyle = '#1b2530'; g.font = 'bold 20px sans-serif'; g.fillText(i + 1, n.x, n.y + 1);
    });
  } else if (mini.kind === 'hammer') {
    const arrows = ['←', '↑', '→', '↓'];
    mini.seq.forEach((d, i) => {
      const x = 50 + i * 68;
      g.fillStyle = i < mini.i ? '#4e9d62' : i === mini.i ? '#d8a13b' : '#2f3d4d';
      g.fillRect(x - 26, 85, 52, 52);
      g.fillStyle = i === mini.i ? '#1b2530' : '#ecdcb8'; g.font = 'bold 30px sans-serif'; g.fillText(arrows[d], x, 112);
    });
    g.font = `30px ${EMOJI_FONT}`; g.fillText('🔨', 220, 40);
  }
}

/* ---------------- meeting ---------------- */
function onMeeting(m) {
  lastMeeting = m;
  if (m.id !== meetingId) {           // new meeting
    meetingId = m.id; $('#chatLog').innerHTML = '';
    closeMini(false); $('#notebook').classList.add('hidden');
    for (const k in keys) keys[k] = false; lastInput = ''; sendInput();
    addChat({ kind: 'sys', text: m.reason });
  }
  meetingOpen = true;
  $('#meeting').classList.remove('hidden');
  renderNotebook();
  $('#mtReason').textContent = m.reason;
  const label = { discuss: 'Discussion', vote: 'Voting', result: 'Results' }[m.stage];
  $('#mtStage').textContent = `${label} · ${m.left}s`;
  const me = m.players.find(p => p.id === myId);
  const alive = me && me.alive;

  const rb = $('#btnReady');
  rb.classList.toggle('hidden', !(m.stage === 'discuss' && alive));
  rb.textContent = me && me.ready ? 'Waiting… (click to undo)' : 'Ready to vote';
  rb.onclick = () => send({ t: 'ready' });
  $('#chatInput').disabled = !alive; $('#btnChat').disabled = !alive;

  const box = $('#mtPlayers'); box.innerHTML = '';
  for (const p of m.players) {
    const d = document.createElement('div'); d.className = 'mp' + (p.alive ? '' : ' dead');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color;
    const nm = document.createElement('span'); nm.textContent = p.name + (p.id === myId ? ' (you)' : '');
    d.append(dot, nm);
    if (m.stage === 'vote' && alive && p.alive) {
      const b = document.createElement('button'); b.textContent = m.myVote === p.id ? 'Voted' : 'Vote';
      if (m.myVote === p.id) b.className = 'sel';
      b.onclick = () => send({ t: 'vote', target: p.id });
      d.append(b);
    } else if (m.stage !== 'result') {
      const st = document.createElement('span'); st.className = 'st';
      st.textContent = !p.alive ? 'out' : m.stage === 'vote' ? (p.voted ? 'voted' : 'thinking…') : (p.ready ? 'ready' : '');
      d.append(st);
    }
    box.append(d);
  }
  if (m.stage === 'vote' && alive) {
    const s = document.createElement('div'); s.className = 'mp';
    s.append(document.createTextNode('Skip vote'));
    const b = document.createElement('button'); b.textContent = m.myVote === 'skip' ? 'Skipping' : 'Skip';
    if (m.myVote === 'skip') b.className = 'sel';
    b.onclick = () => send({ t: 'vote', target: 'skip' });
    s.append(b); box.append(s);
  }

  const rs = $('#mtResult');
  if (m.stage === 'result' && m.result) {
    rs.classList.remove('hidden'); rs.innerHTML = '';
    const h = document.createElement('h3');
    const e = m.result.ejected;
    h.textContent = e ? `${e.name} was ${e.role === 'saboteur' ? 'a SABOTEUR' : 'a Builder (not a saboteur)'}.` : 'Nobody was voted out.';
    if (e && e.role === 'saboteur') h.className = 'role-sab';
    rs.append(h);
    m.result.votes.forEach(v => { const l = document.createElement('div'); l.textContent = `${v.voter} → ${v.target}`; rs.append(l); });
  } else rs.classList.add('hidden');
}
function addChat(m) {
  const log = $('#chatLog'); const d = document.createElement('div');
  if (m.kind === 'sys') { d.className = 'sys'; d.textContent = m.text; }
  else if (m.kind === 'clue') {
    d.className = 'clue';
    const b = document.createElement('b'); b.textContent = m.name + ' '; b.style.color = m.color;
    d.append(b, document.createTextNode(m.text));
  } else {
    const b = document.createElement('b'); b.textContent = m.name + ': '; b.style.color = m.color;
    d.append(b, document.createTextNode(m.text));
  }
  log.append(d); log.scrollTop = log.scrollHeight;
}
function sendChat() {
  const i = $('#chatInput'); const t = i.value.trim();
  if (t) send({ t: 'chat', text: t });
  i.value = '';
}
$('#btnChat').onclick = sendChat;
$('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

function onOver(m) {
  closeMini(false); meetingOpen = false;
  $('#meeting').classList.add('hidden'); $('#notebook').classList.add('hidden'); $('#reveal').classList.add('hidden');
  const crewWin = m.winner === 'crew';
  const iWin = (role === 'crew') === crewWin;
  $('#overTitle').textContent = crewWin ? 'Builders win!' : 'Saboteurs win!';
  $('#overTitle').style.color = crewWin ? '#8fd6a0' : '#ff8b7d';
  $('#overReason').textContent = m.reason + (iWin ? ' You won.' : ' You lost.');
  const ul = $('#overList'); ul.innerHTML = '';
  for (const p of m.players) {
    const li = document.createElement('li');
    const d = document.createElement('span'); d.className = 'dot'; d.style.background = p.color;
    const n = document.createElement('span'); n.textContent = p.name;
    const r = document.createElement('span'); r.className = 'badge' + (p.role === 'saboteur' ? ' role-sab' : '');
    r.textContent = p.role === 'saboteur' ? 'Saboteur' : 'Builder';
    li.append(d, n, r); ul.append(li);
  }
  $('#btnBack').classList.toggle('hidden', !isHost);
  $('#overWait').classList.toggle('hidden', isHost);
  $('#over').classList.remove('hidden');
  send({ t: 'input', dx: 0, dy: 0 }); send({ t: 'hold', on: false });
}

/* ---------------- rendering ---------------- */
const cv = $('#cv'), ctx = cv.getContext('2d');
function emoji(ch, x, y, size, alpha = 1) {
  ctx.globalAlpha = alpha; ctx.font = `${size}px ${EMOJI_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000'; ctx.fillText(ch, x, y); ctx.globalAlpha = 1;
}
function label(t, x, y, color = 'rgba(15,25,20,.75)', size = 12) {
  ctx.font = `bold ${size}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(t, x, y);
}

function draw(dt, now) {
  if (!map) return;
  const S = map.stations;
  ctx.clearRect(0, 0, map.W, map.H);
  ctx.fillStyle = '#7fae63'; ctx.fillRect(0, 0, map.W, map.H);

  // dirt paths
  ctx.strokeStyle = '#c8a86a'; ctx.lineWidth = 22; ctx.lineCap = 'round';
  ctx.beginPath();
  for (const k of ['forest', 'quarry', 'farm', 'generator', 'bell']) { ctx.moveTo(S.store.x, S.store.y); ctx.lineTo(S[k].x, S[k].y); }
  for (const pl of map.plots) { ctx.moveTo(S.store.x, S.store.y); ctx.lineTo(pl.x, pl.y); }
  ctx.stroke();

  // obstacles
  for (const o of map.obstacles) {
    ctx.fillStyle = '#5d6b5c'; ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 8); ctx.fill();
    emoji('🪨', o.x + o.w / 2, o.y + o.h / 2, Math.min(o.w, o.h) * 0.7);
  }

  // stations
  for (const k in S) {
    const s = S[k];
    ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.beginPath(); ctx.arc(s.x, s.y, 34, 0, 7); ctx.fill();
    emoji(s.icon, s.x, s.y, 34);
    label(s.label, s.x, s.y + 46);
  }
  // pylons
  for (const p of map.pylons) { emoji('🗼', p.x, p.y, 28, 0.5); label('Pylon', p.x, p.y + 28); }

  // plots
  if (state) for (const pl of map.plots) {
    const steps = state.steps[pl.id], done = steps >= 3;
    ctx.fillStyle = done ? '#e8d5a8' : 'rgba(255,255,255,.28)';
    ctx.beginPath(); ctx.roundRect(pl.x - 38, pl.y - 38, 76, 76, 10); ctx.fill();
    if (!done) { ctx.setLineDash([6, 5]); ctx.strokeStyle = '#fff8'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]); }
    emoji(pl.icon, pl.x, pl.y - 2, done ? 42 : 34, done ? 1 : 0.25 + steps * 0.25);
    for (let i = 0; i < 3; i++) { ctx.fillStyle = i < steps ? '#4e7d5b' : '#0004'; ctx.beginPath(); ctx.arc(pl.x - 12 + i * 12, pl.y + 27, 4, 0, 7); ctx.fill(); }
    label(pl.name, pl.x, pl.y + 52);
    if (state.damaged[pl.id]) { emoji('💥', pl.x + 28, pl.y - 30, 28); emoji('💨', pl.x - 28, pl.y - 32, 20, 0.8); }
  }

  // players
  const list = Object.entries(P).filter(([id, r]) => r.seen).sort((a, b) => a[1].y - b[1].y);
  for (const [id, r] of list) {
    r.x += (r.tx - r.x) * Math.min(1, dt * 16); r.y += (r.ty - r.y) * Math.min(1, dt * 16);
    const info = roster[id] || { name: '?', color: '#888' };
    const ghost = !r.a;
    ctx.globalAlpha = ghost ? 0.4 : 1;
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.beginPath(); ctx.ellipse(r.x, r.y + 12, 13, 5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = info.color; ctx.strokeStyle = '#1b2530'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(r.x, r.y, 14, 0, 7); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(r.x + r.fx * 5, r.y - 3, 4.5, 0, 7); ctx.fill();
    ctx.fillStyle = '#1b2530'; ctx.beginPath(); ctx.arc(r.x + r.fx * 6.5, r.y - 3, 2, 0, 7); ctx.fill();
    const mate = mates.includes(info.name);
    label(info.name, r.x, r.y - 27, mate ? '#ff5a4a' : '#fff', 12);
    ctx.globalAlpha = 1;
    if (r.w) {
      ctx.strokeStyle = '#d8a13b'; ctx.lineWidth = 3; ctx.beginPath();
      const a0 = now / 200; ctx.arc(r.x, r.y, 21, a0, a0 + 4); ctx.stroke();
      emoji('🔨', r.x + 18, r.y - 20, 16);
    }
  }

  // fog of war
  const me = P[myId];
  if (me && state && myAlive()) {
    const rad = state.lights && role === 'crew' ? 120 : 290;
    const g = ctx.createRadialGradient(me.x, me.y, rad * 0.55, me.x, me.y, rad);
    g.addColorStop(0, 'rgba(8,10,20,0)'); g.addColorStop(1, 'rgba(8,10,20,0.94)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, map.W, map.H);
  }

  // crisis markers (above fog so crew can find them)
  if (state && state.crisis) {
    const c = state.crisis, pulse = 1 + Math.sin(now / 150) * 0.12;
    if (c.type === 'surge') {
      ctx.strokeStyle = `rgba(255,220,80,${0.25 + Math.min(1, c.progress / 4) * 0.7})`; ctx.lineWidth = 4; ctx.setLineDash([10, 8]);
      ctx.beginPath(); ctx.moveTo(c.points[0].x, c.points[0].y); ctx.lineTo(c.points[1].x, c.points[1].y); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const pt of c.points) {
      ctx.strokeStyle = '#ff5a4a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(pt.x, pt.y, 44 * pulse, 0, 7); ctx.stroke();
      emoji(c.type === 'fire' ? '🔥' : '⚡', pt.x, pt.y - 6, 36 * pulse);
    }
  }
  if (state && state.lights) {
    const g = S.generator, pulse = 1 + Math.sin(now / 200) * 0.12;
    ctx.strokeStyle = '#ffd84a'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(g.x, g.y, 46 * pulse, 0, 7); ctx.stroke();
  }
  // watchtower pings
  pings = pings.filter(p => (p.t += dt) < 3.5);
  for (const p of pings) {
    ctx.strokeStyle = `rgba(255,200,60,${1 - p.t / 3.5})`; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(p.x, p.y, 10 + p.t * 40, 0, 7); ctx.stroke();
  }

  // prompt
  const it = findInteract();
  $('#prompt').innerHTML = '';
  if (it && !mini && !meetingOpen) for (const l of it.lines) { const d = document.createElement('div'); d.textContent = l; $('#prompt').append(d); }
  if (state && !myAlive()) { const d = document.createElement('div'); d.textContent = 'You are out. You can still watch — and keep quiet.'; $('#prompt').append(d); }
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!$('#game').classList.contains('hidden')) { updateMini(dt); draw(dt, now); }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
