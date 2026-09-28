'use strict';
/**
 * BUILD & BETRAY — "Among Us with no map", text/emoji only.
 * Run:  npm i ws   then   node server.js   →  http://localhost:3000
 *
 * - You travel between locations (a few seconds each) and do YOUR assigned tasks (minigames).
 * - Saboteurs can pretend to work, kill someone in the same location (then they're locked there for a while),
 *   or sabotage (break a place / start a fire).
 * - Bodies stay where they fell until someone in that location reports them (or an emergency bell is rung).
 * - Meeting -> discuss -> vote. Builders win when ALL assigned tasks are done (task meter 100%).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': (file.endsWith('.html') ? 'text/html' : 'text/plain') + '; charset=utf-8' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const MIN_PLAYERS = 3, MAX_PLAYERS = 10;
const TASKS_PER = 4;                 // real tasks per builder (saboteurs get 4 fake ones)
const TRAVEL = 3.5;                  // seconds to walk between locations
const KILL_CD = 30, KILL_CD_START = 20, KILL_LOCK = 7;
const SAB_CD = 40, SAB_CD_START = 25;
const POST_MEETING_CD = 15;
const FIRE_TIME = 60, FIRE_WINDOW = 25;
const BUSY_MAX = 30, MIN_TASK_MS = 1500;
const DISCUSS_TIME = 45, VOTE_TIME = 30, RESULT_TIME = 7;
const LOG_MAX = 12;
const COLORS = ['🔴', '🔵', '🟢', '🟡', '🟣', '🟠', '🟤', '⚪', '🌸', '🔘'];

const LOCS = {
  forest:   { name: 'Forest',     icon: '🌲' },
  quarry:   { name: 'Quarry',     icon: '⛏️' },
  farm:     { name: 'Farm',       icon: '🌾' },
  workshop: { name: 'Workshop',   icon: '🔨' },
  store:    { name: 'Storehouse', icon: '📦' },
  plaza:    { name: 'Plaza',      icon: '📣' },   // no tasks; emergency bell lives here
};
const TASK_POOL = [
  { id: 'chop',    loc: 'forest',   name: 'Chop firewood',       kind: 'chop' },
  { id: 'berries', loc: 'forest',   name: 'Gather berries',      kind: 'harvest' },
  { id: 'ore',     loc: 'quarry',   name: 'Mine iron ore',       kind: 'mine' },
  { id: 'gravel',  loc: 'quarry',   name: 'Sort the gravel',     kind: 'crates' },
  { id: 'wheat',   loc: 'farm',     name: 'Harvest wheat',       kind: 'harvest' },
  { id: 'chicken', loc: 'farm',     name: 'Feed the chickens',   kind: 'chop' },
  { id: 'beams',   loc: 'workshop', name: 'Hammer the beams',    kind: 'hammer' },
  { id: 'planks',  loc: 'workshop', name: 'Saw the planks',      kind: 'mine' },
  { id: 'stack',   loc: 'store',    name: 'Stack the crates',    kind: 'crates' },
  { id: 'inv',     loc: 'store',    name: 'Log the inventory',   kind: 'hammer' },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const list = room => [...room.players.values()];
const send = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const bcast = (room, o) => { const s = JSON.stringify(o); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); };
const toast = (p, text) => send(p, { t: 'toast', text });
const ev = (p, text) => send(p, { t: 'ev', text });
const evAll = (room, text) => bcast(room, { t: 'ev', text, big: true });
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function genCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
const aliveCrewCount = room => list(room).filter(p => p.alive && p.role === 'crew').length;
const need = room => Math.max(1, Math.min(2, aliveCrewCount(room)));
const presentAt = (room, loc, except) => list(room).filter(q => q !== except && q.alive && q.loc === loc);

/* ------------------------------------------------------------------ */
/* Rooms / lobby                                                       */
/* ------------------------------------------------------------------ */
const rooms = new Map();
const newRoom = code => ({ code, players: new Map(), phase: 'lobby', time: 0, meetingId: 0, meeting: null, bodies: [], broken: {}, fire: null, total: 0, done: 0, logId: 0 });

function sendLobby(room) {
  bcast(room, { t: 'lobby', room: room.code, min: MIN_PLAYERS, players: list(room).map(p => ({ id: p.id, name: p.name, color: p.color, host: p.host })) });
}

let nextId = 1;
function join(ws, m) {
  if (ws.player) return;
  const err = text => ws.send(JSON.stringify({ t: 'error', text }));
  const base = String(m.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12) || 'Builder';
  let room;
  if (m.create) {
    let code; do { code = genCode(); } while (rooms.has(code));
    room = newRoom(code); rooms.set(code, room);
  } else {
    room = rooms.get(String(m.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5));
    if (!room) return err('Room not found. Check the code.');
  }
  if (room.phase !== 'lobby') return err('That game has already started.');
  if (room.players.size >= MAX_PLAYERS) return err('Room is full.');
  let name = base, n = 2;
  while (list(room).some(q => q.name.toLowerCase() === name.toLowerCase())) name = base.slice(0, 10) + n++;
  const used = new Set(list(room).map(q => q.color));
  const p = {
    id: nextId++, ws, room, name, color: COLORS.find(c => !used.has(c)) || '🔵', host: room.players.size === 0,
    connected: true, role: 'crew', alive: true, loc: 'plaza', dest: null, arriveAt: 0, busy: null, lockUntil: 0,
    cd: { kill: 0, sab: 0 }, tasks: [], log: [], route: [], emergency: 1, sharesLeft: 2, routeShared: false, lastView: '',
  };
  ws.player = p; room.players.set(p.id, p);
  send(p, { t: 'joined', id: p.id, room: room.code });
  sendLobby(room);
}

function leave(ws) {
  const p = ws.player; if (!p) return;
  const room = p.room; p.connected = false;
  if (room.phase === 'lobby') room.players.delete(p.id);
  else {
    p.alive = false; p.busy = null;
    if (p.role === 'crew') room.total -= p.tasks.filter(t => !t.done).length;   // their leftover tasks vanish
    if (room.meeting) { delete room.meeting.votes[p.id]; room.meeting.ready.delete(p.id); }
    bcast(room, { t: 'toast', text: p.name + ' left the game.' });
  }
  const conn = list(room).filter(q => q.connected);
  if (!conn.length) { rooms.delete(room.code); return; }
  if (p.host) { p.host = false; conn[0].host = true; send(conn[0], { t: 'host' }); }
  if (room.phase === 'lobby') sendLobby(room);
  else if (room.phase === 'play') checkWin(room);
}

/* ------------------------------------------------------------------ */
/* Start / end                                                         */
/* ------------------------------------------------------------------ */
function startGame(room) {
  const ps = shuffle(list(room));
  const nSab = ps.length >= 7 ? 2 : 1;
  room.time = 0; room.bodies = []; room.meeting = null; room.fire = null; room.done = 0; room.logId = 0;
  room.broken = { forest: false, quarry: false, farm: false, workshop: false, store: false };
  room.total = (ps.length - nSab) * TASKS_PER;
  ps.forEach((p, i) => {
    p.role = i < nSab ? 'saboteur' : 'crew';
    p.alive = true; p.loc = 'plaza'; p.dest = null; p.busy = null; p.lockUntil = 0;
    p.cd = { kill: KILL_CD_START, sab: SAB_CD_START }; p.emergency = 1; p.log = []; p.lastView = '';
    p.route = [{ loc: 'plaza', t: 0 }];
    p.tasks = shuffle(TASK_POOL.slice()).slice(0, TASKS_PER).map(t => ({ ...t, done: false }));
  });
  const roster = list(room).map(p => ({ id: p.id, name: p.name, color: p.color }));
  const sabNames = ps.filter(p => p.role === 'saboteur').map(p => p.name);
  for (const p of list(room)) {
    send(p, { t: 'start', meId: p.id, role: p.role, mates: p.role === 'saboteur' ? sabNames.filter(n => n !== p.name) : [], players: roster, locs: LOCS });
  }
  room.phase = 'play';
  sendViews(room);
}

function endGame(room, winner, reason) {
  if (room.phase === 'over') return true;
  room.phase = 'over'; room.meeting = null;
  bcast(room, { t: 'over', winner, reason, players: list(room).map(p => ({ name: p.name, color: p.color, role: p.role, alive: p.alive })) });
  return true;
}

function checkWin(room) {
  if (room.phase === 'over') return true;
  const alive = list(room).filter(p => p.alive);
  const sab = alive.filter(p => p.role === 'saboteur').length, crew = alive.length - sab;
  if (room.total > 0 && room.done >= room.total) return endGame(room, 'crew', 'Every task was completed!');
  if (sab === 0) return endGame(room, 'crew', 'Every saboteur has been voted out!');
  if (room.fire && room.fire.left <= 0) return endGame(room, 'saboteurs', 'The fire was not put out in time.');
  if (sab >= crew) return endGame(room, 'saboteurs', 'The saboteurs outnumber the builders.');
  return false;
}

/* ------------------------------------------------------------------ */
/* Notebook (limited: recent sightings only)                           */
/* ------------------------------------------------------------------ */
function addLog(room, p, text) {
  if (!p.alive) return;
  const e = { id: 'l' + (++room.logId), text, t: room.time };
  p.log.push(e); if (p.log.length > LOG_MAX) p.log.shift();
  send(p, { t: 'note', id: e.id, text });
}

/* ------------------------------------------------------------------ */
/* Movement / arrivals                                                 */
/* ------------------------------------------------------------------ */
function depart(room, p, dest) {
  const prev = p.loc;
  if (p.alive) for (const q of presentAt(room, prev, p)) { ev(q, `🚶 ${p.name} left.`); addLog(room, q, `Saw ${p.name} leave the ${LOCS[prev].name}`); }
  p.loc = null; p.dest = dest; p.arriveAt = room.time + TRAVEL;
}
function arrive(room, p) {
  const loc = p.dest; p.dest = null; p.loc = loc;
  p.route.push({ loc, t: room.time }); if (p.route.length > 8) p.route.shift();
  if (!p.alive) return;
  const here = presentAt(room, loc, p);
  for (const q of here) { ev(q, `🚶 ${p.name} arrived.`); addLog(room, q, `Saw ${p.name} arrive at the ${LOCS[loc].name}`); }
  addLog(room, p, `Arrived at the ${LOCS[loc].name}; ${here.length ? 'saw ' + here.map(q => q.name).join(', ') : 'nobody was there'}`);
  const bs = room.bodies.filter(b => b.loc === loc);
  if (bs.length) ev(p, `☠️ You found ${bs.map(b => b.name).join(', ')}'s body! You can report it.`);
}

/* ------------------------------------------------------------------ */
/* Views (sent only when something changed)                            */
/* ------------------------------------------------------------------ */
function viewFor(room, p) {
  const v = {
    t: 'view',
    me: {
      loc: p.loc, dest: p.dest, travelLeft: p.dest ? Math.max(0, Math.ceil(p.arriveAt - room.time)) : 0,
      busy: p.busy ? { title: p.busy.title, kind: p.busy.kind } : null,
      lockLeft: Math.max(0, Math.ceil(p.lockUntil - room.time)), alive: p.alive, emergency: p.emergency,
      killCd: Math.ceil(p.cd.kill), sabCd: Math.ceil(p.cd.sab),
    },
    here: p.loc ? presentAt(room, p.loc, p).map(q => ({ id: q.id, name: q.name, color: q.color, working: !!q.busy, mate: p.role === 'saboteur' && q.role === 'saboteur' })) : [],
    bodies: p.loc ? room.bodies.filter(b => b.loc === p.loc).map(b => ({ id: b.id, name: b.name, color: b.color })) : [],
    meter: room.total > 0 ? Math.min(100, Math.floor(room.done / room.total * 100)) : 0,
    tasks: p.tasks.map(t => ({ id: t.id, loc: t.loc, name: t.name, kind: t.kind, done: t.done })),
    broken: room.broken,
    fire: room.fire ? { loc: room.fire.loc, left: Math.ceil(room.fire.left), need: need(room), got: fireHelpers(room) } : null,
  };
  if (!p.alive) v.all = list(room).map(q => ({ name: q.name, color: q.color, alive: q.alive, sab: q.role === 'saboteur', loc: q.loc, dest: q.dest, working: !!q.busy }));
  return v;
}
function sendViews(room) {
  for (const p of list(room)) {
    if (!p.connected) continue;
    const s = JSON.stringify(viewFor(room, p));
    if (s !== p.lastView) { p.lastView = s; if (p.ws.readyState === 1) p.ws.send(s); }
  }
}
function fireHelpers(room) {
  if (!room.fire) return 0;
  return Object.entries(room.fire.helpers).filter(([id, t]) => { const q = room.players.get(+id); return q && q.alive && room.time - t <= FIRE_WINDOW; }).length;
}

/* ------------------------------------------------------------------ */
/* Play loop                                                           */
/* ------------------------------------------------------------------ */
function tickPlay(room, dt) {
  room.time += dt;
  for (const p of list(room)) {
    for (const k in p.cd) p.cd[k] = Math.max(0, p.cd[k] - dt);
    if (p.dest && room.time >= p.arriveAt) arrive(room, p);
    if (p.busy && room.time - p.busy.startT > BUSY_MAX) { p.busy = null; toast(p, 'You took too long and stopped working.'); }
  }
  if (room.fire) {
    room.fire.left -= dt;
    if (room.fire.left <= 0) { checkWin(room); return; }
  }
  sendViews(room);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */
function doKill(room, p, targetId) {
  if (p.role !== 'saboteur' || !p.alive || !p.loc) return;
  if (p.lockUntil > room.time) return toast(p, 'You are locked in place for a moment.');
  if (p.cd.kill > 0) return toast(p, `Kill ready in ${Math.ceil(p.cd.kill)}s.`);
  const v = room.players.get(targetId);
  if (!v || !v.alive || v.role !== 'crew' || v.loc !== p.loc) return toast(p, 'That builder is not here.');
  p.busy = null;
  v.alive = false; v.busy = null;
  room.bodies.push({ id: v.id, name: v.name, color: v.color, loc: p.loc });
  p.cd.kill = KILL_CD; p.lockUntil = room.time + KILL_LOCK;
  const L = LOCS[p.loc];
  for (const w of presentAt(room, p.loc, p)) { ev(w, `👁️ You saw ${p.name} kill ${v.name}!`); addLog(room, w, `Saw ${p.name} kill ${v.name} at the ${L.name}`); }
  send(v, { t: 'dead' });
  toast(p, `You killed ${v.name}. You are locked here for ${KILL_LOCK}s.`);
  checkWin(room);
}

function doSabotage(room, p, kind, loc) {
  if (p.role !== 'saboteur' || !p.alive) return;
  if (p.cd.sab > 0) return toast(p, `Sabotage ready in ${Math.ceil(p.cd.sab)}s.`);
  if (!LOCS[loc] || loc === 'plaza') return;
  if (kind === 'break') {
    if (room.broken[loc]) return toast(p, 'That place is already broken.');
    room.broken[loc] = true;
    evAll(room, `⚠️ SABOTAGE: the ${LOCS[loc].name} broke down! Tasks there are blocked until a builder repairs it.`);
  } else if (kind === 'fire') {
    if (room.fire) return toast(p, 'A fire is already burning.');
    room.fire = { loc, left: FIRE_TIME, helpers: {} };
    evAll(room, `🔥 FIRE at the ${LOCS[loc].name}! ALL tasks are halted. ${need(room)} builder(s) must go there and put it out within ${FIRE_TIME}s!`);
  } else return;
  p.cd.sab = SAB_CD;
}

function startMeeting(room, reason) {
  room.phase = 'meeting';
  room.meeting = { id: ++room.meetingId, stage: 'discuss', left: DISCUSS_TIME, votes: {}, ready: new Set(), result: null, reason };
  for (const p of list(room)) { p.busy = null; p.sharesLeft = 2; p.routeShared = false; p.lastView = ''; }
  sendMeeting(room);
}

function handlePlay(room, p, m) {
  const inPlay = room.phase === 'play';
  switch (m.t) {
    case 'go': {
      if (!inPlay || !p.loc) return;
      const loc = String(m.loc);
      if (!LOCS[loc] || loc === p.loc) return;
      if (p.busy) return toast(p, 'You cannot move while working!');
      if (p.lockUntil > room.time) return toast(p, 'You are locked in place for a moment.');
      depart(room, p, loc);
      break;
    }
    case 'taskStart': {
      if (!inPlay || !p.loc || p.busy) return;
      if (p.lockUntil > room.time) return toast(p, 'You are locked in place for a moment.');
      const what = String(m.what);
      let kind, title, id = null;
      if (what === 'task') {
        const t = p.tasks.find(x => x.id === m.id && !x.done);
        if (!t || t.loc !== p.loc) return toast(p, 'That task is not here.');
        if (room.fire) return toast(p, '🔥 A fire is burning. All tasks are halted!');
        if (room.broken[p.loc]) return toast(p, 'This place is broken. Repair it first.');
        kind = t.kind; title = t.name; id = t.id;
      } else if (what === 'repair') {
        if (!room.broken[p.loc]) return;
        if (!p.alive) return toast(p, 'Ghosts cannot repair.');
        kind = 'rewire'; title = `Repair the ${LOCS[p.loc].name}`;
      } else if (what === 'fire') {
        if (!room.fire || room.fire.loc !== p.loc) return;
        if (!p.alive) return toast(p, 'Ghosts cannot fight fires.');
        kind = 'bucket'; title = 'Put out the fire!';
      } else return;
      p.busy = { what, id, kind, title, loc: p.loc, startAt: Date.now(), startT: room.time };
      send(p, { t: 'taskOk', kind, title });
      break;
    }
    case 'taskDone': {
      if (!inPlay || !p.busy) return;
      const b = p.busy; p.busy = null;
      if (!m.ok || Date.now() - b.startAt < MIN_TASK_MS) return;
      if (b.what === 'task') {
        const t = p.tasks.find(x => x.id === b.id);
        if (!t || t.done || room.fire || room.broken[t.loc]) return toast(p, 'Something interrupted your task.');
        t.done = true;
        if (p.role === 'crew') room.done++;              // saboteur "completions" are fake
        toast(p, `Task finished: ${t.name}`);
        if (p.alive) for (const q of presentAt(room, p.loc, p)) ev(q, `✅ ${p.name} finished a task.`);
        checkWin(room);
      } else if (b.what === 'repair') {
        if (p.role === 'crew' && p.alive && room.broken[b.loc]) { room.broken[b.loc] = false; evAll(room, `✅ The ${LOCS[b.loc].name} was repaired.`); }
        else toast(p, 'Done.');
      } else if (b.what === 'fire') {
        if (p.role === 'crew' && p.alive && room.fire && room.fire.loc === b.loc) {
          room.fire.helpers[p.id] = room.time;
          const got = fireHelpers(room), n = need(room);
          if (got >= n) { room.fire = null; evAll(room, '✅ The fire was put out! Tasks can continue.'); }
          else toast(p, `Fire: ${got}/${n} builders. Others must finish within ${FIRE_WINDOW}s!`);
        } else toast(p, 'Done.');
      }
      break;
    }
    case 'kill': doKill(room, p, +m.target); break;
    case 'sabotage': doSabotage(room, p, String(m.kind), String(m.loc)); break;
    case 'report': {
      if (!inPlay || !p.alive || !p.loc) return;
      const bs = room.bodies.filter(b => b.loc === p.loc);
      if (!bs.length) return toast(p, 'There is no body here.');
      startMeeting(room, `${p.name} reported ${bs.map(b => b.name).join(', ')}'s body at the ${LOCS[p.loc].name}!`);
      return;
    }
    case 'emergency': {
      if (!inPlay || !p.alive || p.loc !== 'plaza' || p.busy) return;
      if (p.emergency <= 0) return toast(p, 'You already used your emergency bell.');
      p.emergency--;
      startMeeting(room, `${p.name} rang the emergency bell!`);
      return;
    }
  }
  if (room.phase === 'play') sendViews(room);
}

/* ------------------------------------------------------------------ */
/* Meeting                                                             */
/* ------------------------------------------------------------------ */
function sendMeeting(room) {
  const m = room.meeting; if (!m) return;
  const players = list(room).map(p => ({ id: p.id, name: p.name, color: p.color, alive: p.alive, voted: m.votes[p.id] !== undefined, ready: m.ready.has(p.id) }));
  for (const p of list(room)) {
    send(p, {
      t: 'meeting', id: m.id, stage: m.stage, left: Math.max(0, Math.ceil(m.left)), reason: m.reason, players,
      myVote: m.votes[p.id] ?? null, result: m.result, sharesLeft: p.sharesLeft, routeLeft: !p.routeShared,
      meter: room.total > 0 ? Math.min(100, Math.floor(room.done / room.total * 100)) : 0,
    });
  }
}
function tally(room) {
  const m = room.meeting, counts = {}, votes = [];
  let skips = 0;
  for (const p of list(room)) {
    if (!p.alive) continue;
    const v = m.votes[p.id]; if (v === undefined) continue;
    const t = room.players.get(v);
    votes.push({ voter: p.name, target: v === 'skip' || !t ? 'Skip' : t.name });
    if (v === 'skip' || !t) skips++; else counts[v] = (counts[v] || 0) + 1;
  }
  let best = 0, ids = [];
  for (const id in counts) { if (counts[id] > best) { best = counts[id]; ids = [id]; } else if (counts[id] === best) ids.push(id); }
  let ejected = null;
  if (ids.length === 1 && best > skips) {
    const p = room.players.get(+ids[0]);
    if (p) { p.alive = false; ejected = { id: p.id, name: p.name, role: p.role }; }
  }
  m.stage = 'result'; m.left = RESULT_TIME; m.result = { ejected, votes };
  sendMeeting(room);
}
function resumePlay(room) {
  room.phase = 'play'; room.bodies = [];
  for (const p of list(room)) {
    p.loc = 'plaza'; p.dest = null; p.busy = null; p.lockUntil = 0; p.lastView = ''; p.log = [];
    p.route = [{ loc: 'plaza', t: room.time }];
    p.cd.kill = Math.max(p.cd.kill, POST_MEETING_CD); p.cd.sab = Math.max(p.cd.sab, POST_MEETING_CD);
  }
  bcast(room, { t: 'meetingEnd' });
  sendViews(room);
}
function tickMeeting(room, dt) {
  const m = room.meeting; if (!m) return;
  const act = list(room).filter(p => p.alive && p.connected);
  m.left -= dt;
  if (m.stage === 'discuss') {
    if (m.left <= 0 || (act.length && act.every(p => m.ready.has(p.id)))) { m.stage = 'vote'; m.left = VOTE_TIME; sendMeeting(room); }
  } else if (m.stage === 'vote') {
    if (m.left <= 0 || (act.length && act.every(p => m.votes[p.id] !== undefined))) tally(room);
  } else if (m.left <= 0) {
    room.meeting = null;
    if (checkWin(room)) return;
    resumePlay(room);
  }
}

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(1, (now - lastTick) / 1000); lastTick = now;
  for (const room of rooms.values()) {
    if (room.phase === 'play') tickPlay(room, dt);
    else if (room.phase === 'meeting') tickMeeting(room, dt);
  }
}, 250);

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */
function handle(ws, m) {
  if (m.t === 'join') return join(ws, m);
  const p = ws.player; if (!p) return;
  const room = p.room;

  switch (m.t) {
    case 'start':
      if (p.host && room.phase === 'lobby') {
        if (room.players.size < MIN_PLAYERS) return toast(p, `You need at least ${MIN_PLAYERS} players.`);
        startGame(room);
      }
      return;
    case 'toLobby':
      if (p.host && room.phase === 'over') {
        room.phase = 'lobby'; room.meeting = null;
        for (const q of [...room.players.values()]) { if (!q.connected) room.players.delete(q.id); else { q.alive = true; q.role = 'crew'; } }
        sendLobby(room);
      }
      return;
    case 'chat': {
      if (!room.meeting || !p.alive) return;
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160);
      if (text) bcast(room, { t: 'chat', name: p.name, color: p.color, text, kind: 'say' });
      return;
    }
    case 'share': {
      if (!room.meeting || !p.alive) return;
      let text;
      if (m.id === 'route') {
        if (p.routeShared) return toast(p, 'You already shared your route this meeting.');
        p.routeShared = true;
        text = `📍 My route: ` + p.route.slice(-4).map(r => `${LOCS[r.loc].name} (${Math.round(room.time - r.t)}s ago)`).join(' → ');
      } else {
        if (p.sharesLeft <= 0) return toast(p, 'You have no more shares this meeting.');
        const e = p.log.find(x => x.id === m.id); if (!e) return;
        p.sharesLeft--;
        text = `📎 ${e.text} (${Math.round(room.time - e.t)}s ago)`;
      }
      bcast(room, { t: 'chat', name: p.name, color: p.color, text, kind: 'clue' });
      sendMeeting(room);
      return;
    }
    case 'ready': {
      const mt = room.meeting;
      if (!mt || mt.stage !== 'discuss' || !p.alive) return;
      if (mt.ready.has(p.id)) mt.ready.delete(p.id); else mt.ready.add(p.id);
      sendMeeting(room);
      return;
    }
    case 'vote': {
      const mt = room.meeting;
      if (!mt || mt.stage !== 'vote' || !p.alive) return;
      if (m.target === 'skip') mt.votes[p.id] = 'skip';
      else { const t = room.players.get(+m.target); if (!t || !t.alive) return; mt.votes[p.id] = t.id; }
      sendMeeting(room);
      return;
    }
  }
  handlePlay(room, p, m);
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error(e); }
  });
  ws.on('close', () => leave(ws));
});

server.listen(PORT, () => console.log(`Build & Betray running → http://localhost:${PORT}`));
