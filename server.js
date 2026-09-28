'use strict';
/**
 * BUILD & BETRAY — text-only, round-based, Mafia-style.
 * Run:  npm install && npm start   →  http://localhost:3000
 *
 * Every round:
 *   1. ACT      everyone secretly picks a location, then is stuck there doing a minigame
 *   2. RESOLVE  kills, sabotage, repairs and task progress are worked out
 *   3. MEETING  everyone learns what happened, talks, then votes someone out
 * Builders win when the task meter hits 100%.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(PUBLIC, url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': (MIME[path.extname(file)] || 'text/plain') + '; charset=utf-8' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server });

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */
const MIN_PLAYERS = 3, MAX_PLAYERS = 10;
const MAX_ROUNDS = 12;
const ACT_TIME = 60, DISCUSS_TIME = 45, VOTE_TIME = 30, RESULT_TIME = 7;
const MIN_TASK_MS = 1500;      // a minigame can't be finished faster than this
const BROKEN_DECAY = 3;        // % of meter lost per unrepaired broken place each round
const COLORS = ['🔴', '🔵', '🟢', '🟡', '🟣', '🟠', '🟤', '⚪', '🌸', '🔘'];

const LOCS = {
  forest:   { name: 'Forest',     icon: '🌲', kind: 'chop',    desc: 'Chop wood (timing game)' },
  quarry:   { name: 'Quarry',     icon: '⛏️', kind: 'mine',    desc: 'Mine stone (stop the cursor)' },
  farm:     { name: 'Farm',       icon: '🌾', kind: 'harvest', desc: 'Harvest crops (click in order)' },
  workshop: { name: 'Workshop',   icon: '🔨', kind: 'hammer',  desc: 'Build (arrow sequence)' },
  store:    { name: 'Storehouse', icon: '📦', kind: 'crates',  desc: 'Sort crates (counting) + audit the round' },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const list = room => [...room.players.values()];
const send = (p, o) => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); };
const bcast = (room, o) => { const s = JSON.stringify(o); for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s); };
const toast = (p, text) => send(p, { t: 'toast', text });
const pick = a => a[Math.floor(Math.random() * a.length)];
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function genCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
const need = room => Math.max(1, Math.min(2, list(room).filter(p => p.alive && p.role === 'crew').length));
const activePlayers = room => list(room).filter(p => p.alive && p.connected);

/* ------------------------------------------------------------------ */
/* Rooms / lobby                                                       */
/* ------------------------------------------------------------------ */
const rooms = new Map();
const newRoom = code => ({ code, players: new Map(), phase: 'lobby', round: 0, meetingId: 0, meeting: null, choices: {}, left: 0 });

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
    connected: true, role: 'crew', alive: true, cd: {}, notes: [], done: false, success: false,
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
    p.alive = false;
    if (room.meeting) { delete room.meeting.votes[p.id]; room.meeting.ready.delete(p.id); }
    bcast(room, { t: 'toast', text: p.name + ' left the game.' });
  }
  const conn = list(room).filter(q => q.connected);
  if (!conn.length) { rooms.delete(room.code); return; }
  if (p.host) { p.host = false; conn[0].host = true; send(conn[0], { t: 'host' }); }
  if (room.phase === 'lobby') sendLobby(room);
  else if (room.phase === 'act') checkWin(room);
}

/* ------------------------------------------------------------------ */
/* Game flow                                                           */
/* ------------------------------------------------------------------ */
function snap(room) {
  return {
    round: room.round, maxRounds: MAX_ROUNDS, meter: Math.round(room.meter), broken: room.broken,
    crisis: room.crisis ? { loc: room.crisis.loc, left: room.crisis.left, need: need(room) } : null,
    players: list(room).map(p => ({ id: p.id, name: p.name, color: p.color, alive: p.alive })),
  };
}

function startGame(room) {
  const ps = shuffle(list(room));
  const nSab = ps.length >= 7 ? 2 : 1;
  const crewN = ps.length - nSab;
  ps.forEach((p, i) => { p.role = i < nSab ? 'saboteur' : 'crew'; p.alive = true; p.cd = { kill: 1, break: 0, crisis: 2 }; p.notes = []; });
  room.round = 0; room.meter = 0;
  room.per = 100 / Math.max(10, crewN * 5);          // % gained per completed task
  room.broken = { forest: false, quarry: false, farm: false, workshop: false, store: false };
  room.crisis = null; room.meeting = null; room.choices = {};
  const roster = list(room).map(p => ({ id: p.id, name: p.name, color: p.color }));
  const sabNames = ps.filter(p => p.role === 'saboteur').map(p => p.name);
  for (const p of list(room)) {
    send(p, { t: 'start', meId: p.id, role: p.role, mates: p.role === 'saboteur' ? sabNames.filter(n => n !== p.name) : [], players: roster, locs: LOCS });
  }
  beginRound(room);
}

function beginRound(room) {
  room.round++;
  if (room.round > MAX_ROUNDS) return endGame(room, 'saboteurs', 'Winter arrived before the tasks were finished.');
  room.phase = 'act'; room.left = ACT_TIME; room.choices = {};
  for (const p of list(room)) { p.done = false; p.success = false; }
  const total = activePlayers(room).length;
  for (const p of list(room)) send(p, { t: 'act', ...snap(room), left: room.left, total, cd: p.role === 'saboteur' ? p.cd : null });
}

function endGame(room, winner, reason, events) {
  if (room.phase === 'over') return true;
  room.phase = 'over'; room.meeting = null;
  bcast(room, { t: 'over', winner, reason, events: events || [], players: list(room).map(p => ({ name: p.name, color: p.color, role: p.role, alive: p.alive })) });
  return true;
}

function checkWin(room, events) {
  if (room.phase === 'over') return true;
  const alive = list(room).filter(p => p.alive);
  const sab = alive.filter(p => p.role === 'saboteur').length, crew = alive.length - sab;
  if (room.meter >= 100) return endGame(room, 'crew', 'The task meter reached 100%!', events);
  if (sab === 0) return endGame(room, 'crew', 'Every saboteur has been voted out!', events);
  if (room.crisis && room.crisis.left <= 0) return endGame(room, 'saboteurs', 'The fire was not put out in time.', events);
  if (sab >= crew) return endGame(room, 'saboteurs', 'The saboteurs outnumber the builders.', events);
  return false;
}

function giveNote(room, p, title, text) {
  const id = `n${room.round}-${p.notes.length}`;
  const note = { id, round: room.round, title, text };
  p.notes.push(note);
  send(p, { t: 'note', ...note });
}

/* ------------------------------------------------------------------ */
/* Resolving a round                                                   */
/* ------------------------------------------------------------------ */
function resolveRound(room) {
  const all = list(room), alive = all.filter(p => p.alive);
  const ch = p => room.choices[p.id] || null;
  const at = p => { const c = ch(p); return c ? c.loc : null; };
  const isCrew = p => p.role === 'crew';
  const priv = {}; all.forEach(p => priv[p.id] = []);
  const events = [];
  const wasBroken = { ...room.broken };
  const crisisActive = room.crisis;
  const present = {};
  for (const k in LOCS) present[k] = alive.filter(p => at(p) === k);
  const killed = new Set(), newBroken = new Set();
  let newCrisis = null;
  const meter0 = room.meter;

  // 1. Saboteur moves (kills first: victims can't run, they are stuck working)
  for (const s of alive.filter(p => p.role === 'saboteur')) {
    const c = ch(s);
    if (!c) { priv[s.id].push('You stayed home this round.'); continue; }
    const L = LOCS[c.loc];
    if (c.act === 'kill') {
      const vics = present[c.loc].filter(p => isCrew(p) && !killed.has(p.id));
      if (s.cd.kill <= 0 && vics.length) {
        const v = pick(vics); killed.add(v.id); v.alive = false; s.cd.kill = 2;
        events.push(`☠️ ${v.name} was found dead at the ${L.name}!`);
        priv[s.id].push(`You killed ${v.name} at the ${L.name}.`);
      } else priv[s.id].push(vics.length ? 'Your kill was not ready.' : `There was nobody to kill at the ${L.name}.`);
    } else if (c.act === 'break') {
      if (!room.broken[c.loc] && s.cd.break <= 0) {
        room.broken[c.loc] = true; newBroken.add(c.loc); s.cd.break = 2;
        events.push(`🔧 The ${L.name} broke down!`);
        priv[s.id].push(`You sabotaged the ${L.name}.`);
      } else priv[s.id].push('Your sabotage did not work.');
    } else if (c.act === 'crisis') {
      if (!room.crisis && !newCrisis && s.cd.crisis <= 0) { newCrisis = { loc: c.loc }; s.cd.crisis = 5; priv[s.id].push(`You will start a fire at the ${L.name}.`); }
      else priv[s.id].push('Your fire did not start.');
    } else priv[s.id].push(`You pretended to work at the ${L.name}.`);
  }
  const survivors = alive.filter(p => !killed.has(p.id));
  const crewOK = loc => survivors.filter(p => isCrew(p) && at(p) === loc && p.success);

  // 2. Repairs (places that were already broken when the round began)
  for (const k in LOCS) {
    if (!wasBroken[k] || (crisisActive && crisisActive.loc === k)) continue;
    const reps = crewOK(k);
    if (reps.length) {
      room.broken[k] = false;
      events.push(`✅ The ${LOCS[k].name} was repaired.`);
      reps.forEach(p => priv[p.id].push(`You repaired the ${LOCS[k].name}.`));
    }
  }

  // 3. Fire fighting
  if (crisisActive) {
    const here = crewOK(crisisActive.loc), n = need(room);
    if (here.length >= n) {
      room.crisis = null;
      events.push(`✅ The fire at the ${LOCS[crisisActive.loc].name} was put out!`);
      here.forEach(p => priv[p.id].push('You helped put out the fire.'));
    } else {
      crisisActive.left--;
      here.forEach(p => priv[p.id].push(`The fire needs ${n} builder(s) together, but only ${here.length} finished.`));
    }
  }

  // 4. Task progress (halted while a fire burned)
  const completed = {};
  const auditors = [];
  for (const p of survivors.filter(isCrew)) {
    const loc = at(p);
    if (!loc) { priv[p.id].push('You stayed home this round.'); continue; }
    const L = LOCS[loc];
    if (crisisActive && loc === crisisActive.loc) continue;                    // handled by fire fighting
    if (wasBroken[loc]) { if (!p.success) priv[p.id].push(`You did not finish repairing the ${L.name}.`); continue; }
    if (crisisActive) { priv[p.id].push('🔥 A fire is burning. Tasks give no progress!'); continue; }
    if (newBroken.has(loc)) { priv[p.id].push(`The ${L.name} broke down while you worked. No progress.`); continue; }
    if (!p.success) { priv[p.id].push(`You did not finish the task at the ${L.name}.`); continue; }
    completed[loc] = (completed[loc] || 0) + 1;
    room.meter = Math.min(100, room.meter + room.per);
    priv[p.id].push(`Task done at the ${L.name}: +${room.per.toFixed(1)}%.`);
    if (loc === 'store') auditors.push(p);
  }
  for (const p of auditors) {
    const lines = Object.keys(LOCS).map(k => {
      const L = LOCS[k];
      if (wasBroken[k] || newBroken.has(k)) return `${L.icon} ${L.name}: closed (broken)`;
      return `${L.icon} ${L.name}: ${present[k].length} arrived, ${completed[k] || 0} finished`;
    });
    giveNote(room, p, 'Storehouse audit', lines.join('\n'));
  }

  // 5. Fire starts after the work (takes effect next round)
  if (newCrisis) {
    room.crisis = { loc: newCrisis.loc, left: 2 };
    events.push(`🔥 FIRE at the ${LOCS[newCrisis.loc].name}! All tasks stop until ${need(room)} builder(s) put it out together. You have 2 rounds!`);
  }

  // 6. Broken places slowly eat the meter
  const brokenNow = Object.keys(room.broken).filter(k => room.broken[k]);
  if (brokenNow.length) room.meter = Math.max(0, room.meter - BROKEN_DECAY * brokenNow.length);
  const delta = Math.round(room.meter - meter0);
  events.push(`📊 Task meter: ${Math.round(room.meter)}% (${delta >= 0 ? '+' : ''}${delta}%)`);
  if (brokenNow.length) events.push(`🔧 Still broken: ${brokenNow.map(k => LOCS[k].name).join(', ')} (−${BROKEN_DECAY}% each round).`);
  if (!killed.size) events.push('Nobody died this round.');

  // 7. Private sightings: who was at your location
  for (const p of survivors) {
    const loc = at(p); if (!loc) continue;
    const names = present[loc].filter(q => q !== p).map(q => q.name + (killed.has(q.id) ? ' ☠️' : ''));
    priv[p.id].push(names.length ? `👀 You saw ${names.join(', ')} at the ${LOCS[loc].name}.` : `👀 You were alone at the ${LOCS[loc].name}.`);
  }
  const reveal = Object.keys(LOCS).map(k => `${LOCS[k].icon} ${LOCS[k].name}: ${present[k].map(p => p.name + (killed.has(p.id) ? ' ☠️' : '')).join(', ') || '—'}`).join('\n');
  for (const p of all) {
    if (!p.alive && p.connected) giveNote(room, p, 'Full reveal (spectator)', reveal);
    else if (p.alive) giveNote(room, p, `Round ${room.round}: what you saw`, priv[p.id].join('\n'));
  }

  for (const s of all) for (const k in s.cd) s.cd[k] = Math.max(0, s.cd[k] - 1);
  if (checkWin(room, events)) return;
  startMeeting(room, events);
}

/* ------------------------------------------------------------------ */
/* Meeting                                                             */
/* ------------------------------------------------------------------ */
function startMeeting(room, events) {
  room.phase = 'meeting';
  room.meeting = { id: ++room.meetingId, stage: 'discuss', left: DISCUSS_TIME, votes: {}, ready: new Set(), result: null, events };
  sendMeeting(room);
}
function sendMeeting(room) {
  const m = room.meeting; if (!m) return;
  const players = list(room).map(p => ({ id: p.id, name: p.name, color: p.color, alive: p.alive, voted: m.votes[p.id] !== undefined, ready: m.ready.has(p.id) }));
  for (const p of list(room)) {
    send(p, { t: 'meeting', ...snap(room), id: m.id, stage: m.stage, left: Math.max(0, Math.ceil(m.left)), events: m.events, players, myVote: m.votes[p.id] ?? null, result: m.result });
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
function tickMeeting(room, dt) {
  const m = room.meeting; if (!m) return;
  const alive = activePlayers(room);
  m.left -= dt;
  if (m.stage === 'discuss') {
    if (m.left <= 0 || (alive.length && alive.every(p => m.ready.has(p.id)))) { m.stage = 'vote'; m.left = VOTE_TIME; sendMeeting(room); }
  } else if (m.stage === 'vote') {
    if (m.left <= 0 || (alive.length && alive.every(p => m.votes[p.id] !== undefined))) tally(room);
  } else if (m.left <= 0) {
    room.meeting = null;
    bcast(room, { t: 'meetingEnd' });
    if (checkWin(room)) return;
    beginRound(room);
  }
}

/* ------------------------------------------------------------------ */
/* Tick                                                                */
/* ------------------------------------------------------------------ */
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now(), dt = Math.min(1, (now - lastTick) / 1000); lastTick = now;
  for (const room of rooms.values()) {
    if (room.phase === 'act') {
      room.left -= dt;
      const act = activePlayers(room);
      if (room.left <= 0 || (act.length && act.every(p => p.done))) resolveRound(room);
    } else if (room.phase === 'meeting') tickMeeting(room, dt);
  }
}, 250);

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */
function progressMsg(room) {
  const act = activePlayers(room);
  bcast(room, { t: 'progress', done: act.filter(p => p.done).length, total: act.length });
}

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
      break;
    case 'toLobby':
      if (p.host && room.phase === 'over') {
        room.phase = 'lobby'; room.meeting = null;
        for (const q of [...room.players.values()]) { if (!q.connected) room.players.delete(q.id); else { q.alive = true; q.role = 'crew'; } }
        sendLobby(room);
      }
      break;

    case 'pick': {                       // choosing a location is final: you can't move while working
      if (room.phase !== 'act' || !p.alive) return;
      if (room.choices[p.id] || p.done) return toast(p, 'You are busy. You cannot move while working!');
      const loc = String(m.loc);
      if (!LOCS[loc]) return;
      let act = 'work';
      if (p.role === 'saboteur') {
        act = ['fake', 'kill', 'break', 'crisis'].includes(m.act) ? m.act : 'fake';
        if (act === 'break' && room.broken[loc]) return toast(p, 'That place is already broken.');
        if (act === 'crisis' && room.crisis) return toast(p, 'A fire is already burning.');
        if (act !== 'fake' && p.cd[act] > 0) return toast(p, `That move is not ready (${p.cd[act]} round(s)).`);
      }
      room.choices[p.id] = { loc, act, at: Date.now() };
      const kind = room.crisis && room.crisis.loc === loc ? 'bucket' : room.broken[loc] ? 'rewire' : LOCS[loc].kind;
      send(p, { t: 'myChoice', loc, act: p.role === 'saboteur' ? act : 'fake', kind });
      break;
    }
    case 'stay':
      if (room.phase !== 'act' || !p.alive || room.choices[p.id] || p.done) return;
      p.done = true; progressMsg(room);
      break;
    case 'taskDone': {
      if (room.phase !== 'act' || !p.alive || p.done) return;
      const c = room.choices[p.id]; if (!c) return;
      p.done = true;
      p.success = !!m.ok && Date.now() - c.at >= MIN_TASK_MS;
      progressMsg(room);
      break;
    }

    case 'chat': {
      if (!room.meeting || !p.alive) return;
      const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160);
      if (text) bcast(room, { t: 'chat', name: p.name, color: p.color, text, kind: 'say' });
      break;
    }
    case 'share': {
      if (!room.meeting || !p.alive) return;
      const n = p.notes.find(x => x.id === m.id);
      if (n) bcast(room, { t: 'chat', name: p.name, color: p.color, text: `📎 ${n.title}\n${n.text}`, kind: 'clue' });
      break;
    }
    case 'ready': {
      const mt = room.meeting;
      if (!mt || mt.stage !== 'discuss' || !p.alive) return;
      if (mt.ready.has(p.id)) mt.ready.delete(p.id); else mt.ready.add(p.id);
      sendMeeting(room);
      break;
    }
    case 'vote': {
      const mt = room.meeting;
      if (!mt || mt.stage !== 'vote' || !p.alive) return;
      if (m.target === 'skip') mt.votes[p.id] = 'skip';
      else { const t = room.players.get(+m.target); if (!t || !t.alive) return; mt.votes[p.id] = t.id; }
      sendMeeting(room);
      break;
    }
  }
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
