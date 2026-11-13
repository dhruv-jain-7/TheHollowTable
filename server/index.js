import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { Pool } from 'pg';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import {
  getDiscussionSeconds,
  getMafiaCap,
  chooseMafiaTarget,
  resolveVote,
  getWinner,
  getNightActionProgress,
  allPlayersReady,
  allPlayersVoted,
  canTargetSelf,
} from './rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3001);
const isProduction = process.env.NODE_ENV === 'production';
const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || !isProduction || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Origin is not allowed by this game server.'));
      }
    },
    methods: ['GET', 'POST'],
  },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    const allowed = !origin || !isProduction || allowedOrigins.includes(origin);
    callback(allowed ? null : new Error('Origin is not allowed by this game server.'), allowed);
  },
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6,
});

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '32kb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'The Hollow Table', time: Date.now() }));

const rooms = new Map();
const socketByPlayer = new Map();
const joinAttempts = new Map();
const chatAttempts = new Map();
let pool = null;
let livekitRoomService = null;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AVATAR_IDS = new Set(['raven','skull','ghost','bat','wolf','cat','owl','spider','moth','snake','candle','rose','moon','pumpkin','key','crow','coffin','crystal','mask','poison','blackheart','eye','rose2','moon2']);
const NIGHT_SECONDS = 55;
const VOTE_SECONDS = 60;
const TIE_SECONDS = 5 * 60;
const RECONNECT_GRACE_MS = 45_000;
const ROOM_TTL_HOURS = 24;

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function makeCode() {
  let code = '';
  for (let index = 0; index < 4; index += 1) {
    code += CODE_ALPHABET[randomBytes(1)[0] % CODE_ALPHABET.length];
  }
  return code;
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\u0000-\u001F]/g, '').trim().replace(/\s+/g, ' ').slice(0, 18);
}

function cleanMessage(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\u0000-\u001F]/g, '').trim().slice(0, 350);
}

function reply(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

function error(message) {
  return { ok: false, error: message };
}

function success(payload = {}) {
  return { ok: true, ...payload };
}

function randomFrom(list) {
  return list[randomBytes(2).readUInt16BE(0) % list.length];
}

function freshActions() {
  return {
    mafiaVotes: {},
    sheriffTarget: null,
    angelTarget: null,
    dayVotes: {},
    dayReady: {},
  };
}

function playerById(room, playerId) {
  return room.players.find((player) => player.id === playerId) ?? null;
}

function livingPlayers(room) {
  return room.players.filter((player) => player.alive);
}

function makeAnnouncement(kind, title, text, accent = 'red', extra = {}) {
  return { id: randomUUID(), kind, title, text, accent, ...extra, createdAt: Date.now() };
}

const murderStories = [
  (name) => `${name} was found beneath the old staircase. The floorboards were wet. No one heard a thing.`,
  (name) => `A candle burned in ${name}'s room. At dawn, the bed was empty and the locked door stood open.`,
  (name) => `${name} followed a whisper into the cellar. The door slammed. The house went quiet.`,
  (name) => `The clock stopped at 3:13. ${name} was gone. A fresh handprint marked the wall.`,
  (name) => `The fog swallowed ${name} beneath the courtyard arch. Only their footsteps came back.`,
  (name) => `${name}'s chair was empty. A dark stain crossed the floor and vanished beneath the table.`,
];

const eliminationStories = [
  (name) => `${name} walked into the candlelit hall. The doors closed. The table had made its choice.`,
  (name) => `The ballroom lights went out as ${name} entered. When they returned, the room was empty.`,
  (name) => `The lift carried ${name} below the house. It never came back.`,
  (name) => `Black mist filled the winter garden. ${name} did not return.`,
  (name) => `A final invitation waited for ${name}. The music played, but no one saw them again.`,
  (name) => `The staircase groaned. A shadow moved the wrong way. Then came silence. ${name} was gone.`,
];

function roleDescription(role) {
  const descriptions = {
    mafia: 'Choose one victim with your team each night. Every living Mafia member must agree on the same name.',
    sheriff: 'Inspect one player each night. Your result is private.',
    angel: 'Protect one player each night, including yourself. Your protection is never revealed.',
    citizen: 'Listen, discuss, and vote to find the Mafia.',
  };
  return descriptions[role] ?? '';
}


function makeSnapshot(room, playerId) {
  const me = playerById(room, playerId);
  if (!me) return null;
  const revealAll = room.status === 'finished';
  const mafiaTeam = me.role === 'mafia' && me.alive
    ? room.players.filter((p) => p.role === 'mafia').map((p) => ({ id: p.id, name: p.name, alive: p.alive }))
    : [];
  const myActionSubmitted = room.phase === 'night'
    ? (me.role === 'mafia' ? Boolean(room.actions.mafiaVotes[me.id])
      : me.role === 'sheriff' ? Boolean(room.actions.sheriffTarget)
        : me.role === 'angel' ? Boolean(room.actions.angelTarget) : false)
    : ['voting', 'tieVoting'].includes(room.phase) ? Object.hasOwn(room.actions.dayVotes, me.id) : false;
  const chat = room.chat.filter((message) => message.scope === 'public' || (message.scope === 'mafia' && me.role === 'mafia' && me.alive));
  const dayReady = room.actions.dayReady ?? {};
  const nightProgress = room.phase === 'night' ? getNightActionProgress(room) : null;
  const mafiaChoices = me.role === 'mafia' && me.alive
    ? room.players.filter((player) => player.alive && player.role === 'mafia').map((player) => {
        const targetId = room.actions.mafiaVotes?.[player.id];
        const target = targetId ? playerById(room, targetId) : null;
        return { id: player.id, name: player.name, targetName: target?.alive ? target.name : null, submitted: Boolean(targetId) };
      })
    : [];
  return {
    code: room.code,
    serverNow: Date.now(),
    status: room.status,
    hostId: room.hostId,
    settings: { ...room.settings },
    playerCount: room.players.length,
    players: room.players.map((player) => ({
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      alive: player.alive,
      connected: player.connected,
      isHost: player.id === room.hostId,
      role: revealAll || !player.alive ? player.role : null,
    })),
    phase: room.phase,
    round: room.round,
    phaseEndsAt: room.phaseEndsAt,
    announcement: room.announcement,
    lastDeathAnnouncement: room.lastDeathAnnouncement ?? null,
    winner: room.winner,
    tieCandidates: room.tieCandidates.map((id) => {
      const target = playerById(room, id);
      return target ? { id: target.id, name: target.name, avatar: target.avatar } : null;
    }).filter(Boolean),
    discussionReadiness: {
      ready: livingPlayers(room).filter((player) => dayReady[player.id]).length,
      required: livingPlayers(room).length,
    },
    mafiaChoices,
    chat,
    me: {
      id: me.id,
      name: me.name,
      avatar: me.avatar,
      role: me.role ?? null,
      roleDescription: me.role ? roleDescription(me.role) : '',
      alive: me.alive,
      connected: me.connected,
      isHost: me.id === room.hostId,
      myActionSubmitted,
      readyToVote: Boolean(dayReady[me.id]),
      mafiaTeam,
      privateResults: me.privateResults ?? [],
    },
    actionProgress: room.phase === 'night'
      ? me.role === 'mafia' && me.alive ? {
          submitted: nightProgress.mafiaSubmitted,
          required: nightProgress.mafiaRequired,
          mafiaAgreed: nightProgress.mafiaDone,
        } : { submitted: 0, required: 0, mafiaAgreed: false }
      : ['voting', 'tieVoting'].includes(room.phase) ? {
          submitted: Object.keys(room.actions.dayVotes ?? {}).length,
          required: livingPlayers(room).length,
        } : { submitted: 0, required: 0 },
  };
}

async function saveRoom(room) {
  if (!pool || !room) return;
  try {
    const expiresAt = new Date(Date.now() + ROOM_TTL_HOURS * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO hollow_rooms (code, state, updated_at, expires_at)
       VALUES ($1, $2::jsonb, NOW(), $3)
       ON CONFLICT (code) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW(), expires_at = EXCLUDED.expires_at`,
      [room.code, JSON.stringify(room), expiresAt],
    );
  } catch (err) {
    console.error('Could not persist room:', err.message);
  }
}

async function deleteRoom(code) {
  rooms.delete(code);
  if (pool) {
    try { await pool.query('DELETE FROM hollow_rooms WHERE code = $1', [code]); }
    catch (err) { console.error('Could not delete room:', err.message); }
  }
}

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Room state will be in memory only.');
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hollow_rooms (
      code CHAR(4) PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hollow_rooms_expires_at_idx ON hollow_rooms (expires_at);
  `);
  const { rows } = await pool.query('SELECT state FROM hollow_rooms WHERE expires_at > NOW()');
  for (const row of rows) {
    const room = row.state;
    if (!room || !room.code || !Array.isArray(room.players)) continue;
    for (const player of room.players) player.connected = false;
    room.hostGraceUntil = null;
    rooms.set(room.code, room);
  }
  await pool.query('DELETE FROM hollow_rooms WHERE expires_at <= NOW()');
  console.log(`Restored ${rooms.size} game room(s) from PostgreSQL.`);
}

function attachSocket(room, player, socket) {
  const currentHost = playerById(room, room.hostId);
  if (!currentHost || !currentHost.connected) {
    room.hostId = player.id;
    room.hostGraceUntil = null;
  }
  const previousSocketId = socketByPlayer.get(player.id);
  if (previousSocketId && previousSocketId !== socket.id) {
    io.to(previousSocketId).emit('session:replaced');
    io.sockets.sockets.get(previousSocketId)?.disconnect(true);
  }
  player.connected = true;
  player.disconnectAt = null;
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(`table:${room.code}`);
  socketByPlayer.set(player.id, socket.id);
}

function emitRoom(room) {
  for (const player of room.players) {
    if (!player.connected) continue;
    const socketId = socketByPlayer.get(player.id);
    if (!socketId) continue;
    const snapshot = makeSnapshot(room, player.id);
    if (snapshot) io.to(socketId).emit('room:state', snapshot);
  }
}

async function commit(room) {
  room.lastActivityAt = Date.now();
  emitRoom(room);
  await saveRoom(room);
}

function addPrivateResult(player, text, kind = 'info') {
  player.privateResults ??= [];
  player.privateResults.unshift({ id: randomUUID(), text, kind, at: Date.now() });
  player.privateResults = player.privateResults.slice(0, 12);
}

function setDiscussion(room) {
  room.phase = 'discussion';
  room.phaseEndsAt = Date.now() + getDiscussionSeconds(room.round) * 1000;
  room.tieCandidates = [];
  room.actions.dayVotes = {};
  room.actions.dayReady = {};
}

function everyoneReadyForVote(room) {
  const livingIds = livingPlayers(room).map((player) => player.id);
  return allPlayersReady(livingIds, room.actions.dayReady ?? {});
}

function everyoneVoted(room) {
  const livingIds = livingPlayers(room).map((player) => player.id);
  return allPlayersVoted(livingIds, room.actions.dayVotes ?? {});
}

function beginVoting(room) {
  room.phase = 'voting';
  room.phaseEndsAt = Date.now() + VOTE_SECONDS * 1000;
  room.actions.dayVotes = {};
  room.actions.dayReady = {};
  room.announcement = makeAnnouncement('phase', 'THE VOTE BEGINS', 'Choose the name you believe is hiding in the dark. The vote is private.', 'gold');
}

function beginNextNight(room) {
  room.round += 1;
  room.phase = 'night';
  room.phaseEndsAt = Date.now() + NIGHT_SECONDS * 1000;
  room.actions = freshActions();
  room.tieCandidates = [];
}

function finishGame(room, winner) {
  room.status = 'finished';
  room.phase = 'finished';
  room.phaseEndsAt = null;
  room.winner = winner;
  room.finishedAt = Date.now();
  room.announcement = makeAnnouncement(
    'victory',
    winner === 'mafia' ? 'THE MAFIA CLAIM THE HOUSE' : 'THE TOWN SURVIVES THE NIGHT',
    winner === 'mafia'
      ? 'The last candle gutters out. The Mafia have taken the table, and the house belongs to them.'
      : 'The final shadow retreats beyond the gates. Every member of the Mafia has been unmasked. The town survives.',
    winner === 'mafia' ? 'red' : 'gold',
  );
}

function checkVictory(room) {
  const winner = getWinner(room.players);
  if (!winner) return false;
  finishGame(room, winner);
  return true;
}

function removeEliminatedPlayerFromVoice(room, player) {
  if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) return;
  try {
    if (!livekitRoomService) {
      const httpUrl = process.env.LIVEKIT_URL.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:');
      livekitRoomService = new RoomServiceClient(httpUrl, process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    }
    const mode = room.phase === 'night' ? 'night' : 'day';
    const voiceRoom = `hollow-${room.code}-${mode}-${room.round}`;
    livekitRoomService.removeParticipant(voiceRoom, player.id, { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) })
      .catch((err) => console.warn('LiveKit participant removal:', err.message));
  } catch (err) {
    console.warn('LiveKit participant removal could not start:', err.message);
  }
}

function forfeitPlayer(room, player) {
  if (!player || !player.alive) return false;
  player.alive = false;
  player.eliminatedAt = Date.now();
  removeEliminatedPlayerFromVoice(room, player);
  room.announcement = makeAnnouncement(
    'departure',
    'A SEAT FALLS SILENT',
    `${player.name} has abandoned the table. Their chair remains empty, and the house counts the silence as a final confession.`,
    'muted',
  );
  room.lastDeathAnnouncement = room.announcement;
  return true;
}

function eliminatePlayer(room, targetId, type) {
  const target = playerById(room, targetId);
  if (!target || !target.alive) return false;
  target.alive = false;
  removeEliminatedPlayerFromVoice(room, target);
  target.eliminatedAt = Date.now();
  if (type === 'murder') {
    room.announcement = makeAnnouncement(
      'murder',
      'A MURDER IN THE DARK',
      randomFrom(murderStories)(target.name),
      'red',
      { victimName: target.name },
    );
  } else {
    room.announcement = makeAnnouncement(
      'elimination',
      'THE TABLE HAS PASSED ITS JUDGEMENT',
      randomFrom(eliminationStories)(target.name),
      'gold',
    );
  }
  room.lastDeathAnnouncement = room.announcement;
  return true;
}

function resolveNight(room) {
  if (room.status !== 'playing' || room.phase !== 'night') return;
  const livingIds = livingPlayers(room).map((player) => player.id);
  const livingMafiaIds = room.players.filter((player) => player.alive && player.role === 'mafia').map((player) => player.id);
  const murderTargetId = chooseMafiaTarget(room.actions.mafiaVotes, livingIds, livingMafiaIds);
  const protectedTargetId = room.actions.angelTarget;
  const sheriff = room.players.find((player) => player.alive && player.role === 'sheriff');
  if (sheriff && room.actions.sheriffTarget) {
    const inspected = playerById(room, room.actions.sheriffTarget);
    if (inspected && inspected.alive) {
      addPrivateResult(sheriff, `${inspected.name} is ${inspected.role === 'mafia' ? 'MAFIA' : 'NOT MAFIA'}.`, inspected.role === 'mafia' ? 'danger' : 'success');
    }
  }
  if (murderTargetId && murderTargetId !== protectedTargetId) {
    eliminatePlayer(room, murderTargetId, 'murder');
  } else {
    room.announcement = makeAnnouncement('quiet', 'THE NIGHT LEFT NO TRACE', 'No one was found at dawn. Whatever moved through the house kept its secret.', 'muted');
  }
  if (checkVictory(room)) return;
  setDiscussion(room);
}

function resolveDayVoting(room, isTieBreak = false) {
  const allowed = isTieBreak ? new Set(room.tieCandidates) : null;
  const result = resolveVote(room.actions.dayVotes, allowed, isTieBreak);
  if (result.type === 'eliminate') {
    eliminatePlayer(room, result.targetId, 'elimination');
    if (checkVictory(room)) return;
    beginNextNight(room);
    return;
  }
  if (result.type === 'tie') {
    room.phase = 'tieVoting';
    room.phaseEndsAt = Date.now() + TIE_SECONDS * 1000;
    room.tieCandidates = result.candidates;
    room.actions.dayVotes = {};
    const names = result.candidates.map((id) => playerById(room, id)?.name).filter(Boolean).join(' and ');
    room.announcement = makeAnnouncement('tie', 'THE TABLE CANNOT AGREE', `${names} stand accused. Five minutes remain for the living to reconsider their votes. Only the tied candidates may receive votes.`, 'gold');
    return;
  }
  room.tieCandidates = [];
  room.announcement = makeAnnouncement('no-elimination', 'NO ONE LEAVES THE TABLE', 'The votes remain divided. The table has reached no verdict, and no one is eliminated.', 'muted');
  beginNextNight(room);
}

async function tickRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    let changed = false;
    if (room.hostGraceUntil && now >= room.hostGraceUntil) {
      const nextHost = room.players.find((player) => player.connected)?.id;
      if (nextHost) room.hostId = nextHost;
      room.hostGraceUntil = null;
      changed = true;
    }
    if (room.status === 'playing' && room.phaseEndsAt && now >= room.phaseEndsAt) {
      if (room.phase === 'night') resolveNight(room);
      else if (room.phase === 'discussion') beginVoting(room);
      else if (room.phase === 'voting') resolveDayVoting(room, false);
      else if (room.phase === 'tieVoting') resolveDayVoting(room, true);
      changed = true;
    }
    if (now - (room.lastActivityAt || room.createdAt || now) > ROOM_TTL_HOURS * 60 * 60 * 1000) {
      await deleteRoom(room.code);
      continue;
    }
    if (changed) await commit(room);
  }
}

function ipAllowed(ip) {
  const now = Date.now();
  const item = joinAttempts.get(ip) ?? { count: 0, resetAt: now + 5 * 60 * 1000 };
  if (now > item.resetAt) {
    item.count = 0;
    item.resetAt = now + 5 * 60 * 1000;
  }
  item.count += 1;
  joinAttempts.set(ip, item);
  return item.count <= 18;
}

function chatAllowed(playerId) {
  const now = Date.now();
  const entries = (chatAttempts.get(playerId) ?? []).filter((time) => now - time < 5000);
  if (entries.length >= 5) return false;
  entries.push(now);
  chatAttempts.set(playerId, entries);
  return true;
}

function socketPlayer(socket) {
  const room = rooms.get(socket.data.code);
  const player = room ? playerById(room, socket.data.playerId) : null;
  if (!room || !player) return null;
  return { room, player };
}

function withPlayer(socket, callback, handler) {
  return async (payload = {}, ack) => {
    try {
      const context = socketPlayer(socket);
      if (!context) return reply(ack, error('Your table session has expired. Rejoin using your table code.'));
      const result = await handler(context.room, context.player, payload);
      reply(ack, result ?? success());
    } catch (err) {
      console.error(`Socket action ${callback} failed:`, err);
      reply(ack, error('Something went wrong. Please try again.'));
    }
  };
}

io.on('connection', (socket) => {
  socket.on('room:create', async (payload = {}, ack) => {
    try {
      const ip = socket.handshake.address || 'unknown';
      if (!ipAllowed(ip)) return reply(ack, error('Too many room attempts. Please wait a few minutes and try again.'));
      const name = cleanName(payload.name);
      const avatar = AVATAR_IDS.has(String(payload.avatar)) ? String(payload.avatar) : 'raven';
      const maxPlayers = Math.min(16, Math.max(5, Number(payload.maxPlayers) || 10));
      if (name.length < 2) return reply(ack, error('Choose a nickname with at least two characters.'));
      let code = makeCode();
      let attempts = 0;
      while (rooms.has(code) && attempts < 100) { code = makeCode(); attempts += 1; }
      if (rooms.has(code)) return reply(ack, error('Could not create a unique table code. Try again.'));
      const id = randomUUID();
      const token = randomBytes(32).toString('hex');
      const room = {
        code,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'lobby',
        hostId: id,
        hostGraceUntil: null,
        settings: { maxPlayers, mafiaCount: Math.min(2, getMafiaCap(maxPlayers)) },
        players: [{ id, name, avatar, tokenHash: hashToken(token), role: null, alive: true, connected: true, joinedAt: Date.now(), privateResults: [] }],
        phase: 'lobby',
        round: 0,
        phaseEndsAt: null,
        actions: freshActions(),
        tieCandidates: [],
        announcement: makeAnnouncement('welcome', 'THE HOLLOW TABLE', 'The house has opened its doors. Invite only those you trust.', 'gold'),
        chat: [],
        winner: null,
      };
      rooms.set(code, room);
      attachSocket(room, room.players[0], socket);
      await commit(room);
      reply(ack, success({ code, token, snapshot: makeSnapshot(room, id) }));
    } catch (err) {
      console.error('Create room failed:', err);
      reply(ack, error('The table could not be created. Please try again.'));
    }
  });

  socket.on('room:join', async (payload = {}, ack) => {
    try {
      const ip = socket.handshake.address || 'unknown';
      if (!ipAllowed(ip)) return reply(ack, error('Too many join attempts. Please wait a few minutes and try again.'));
      const code = String(payload.code || '').trim().toUpperCase();
      const name = cleanName(payload.name);
      let avatar = AVATAR_IDS.has(String(payload.avatar)) ? String(payload.avatar) : 'raven';
      if (!/^[A-HJ-NP-Z2-9]{4}$/.test(code)) return reply(ack, error('Enter a valid four-character table code.'));
      const room = rooms.get(code);
      if (!room) return reply(ack, error('No table was found with that code. Check the code and try again.'));
      if (room.status !== 'lobby') return reply(ack, error('This game has already started. New players cannot join.'));
      if (room.players.length >= room.settings.maxPlayers) return reply(ack, error('This table is full.'));
      if (name.length < 2) return reply(ack, error('Choose a nickname with at least two characters.'));
      if (room.players.some((player) => player.name.toLowerCase() === name.toLowerCase())) return reply(ack, error('That nickname is already taken at this table.'));
      if (room.players.some((player) => player.avatar === avatar)) {
        avatar = [...AVATAR_IDS].find((candidate) => !room.players.some((player) => player.avatar === candidate));
      }
      if (!avatar) return reply(ack, error('All portraits at this table are taken.'));
      const id = randomUUID();
      const token = randomBytes(32).toString('hex');
      const player = { id, name, avatar, tokenHash: hashToken(token), role: null, alive: true, connected: true, joinedAt: Date.now(), privateResults: [] };
      room.players.push(player);
      attachSocket(room, player, socket);
      await commit(room);
      reply(ack, success({ code, token, snapshot: makeSnapshot(room, id) }));
    } catch (err) {
      console.error('Join room failed:', err);
      reply(ack, error('Could not join this table. Please try again.'));
    }
  });

  socket.on('room:resume', async (payload = {}, ack) => {
    try {
      const code = String(payload.code || '').trim().toUpperCase();
      const token = String(payload.token || '');
      const room = rooms.get(code);
      if (!room || !token) return reply(ack, error('Saved table session not found.'));
      const tokenHash = hashToken(token);
      const player = room.players.find((entry) => entry.tokenHash === tokenHash);
      if (!player) return reply(ack, error('This reconnect code is no longer valid.'));
      attachSocket(room, player, socket);
      if (room.hostId === player.id) room.hostGraceUntil = null;
      await commit(room);
      reply(ack, success({ code, snapshot: makeSnapshot(room, player.id) }));
    } catch (err) {
      console.error('Resume room failed:', err);
      reply(ack, error('Could not restore your seat. Please try again.'));
    }
  });

  socket.on('lobby:update', withPlayer(socket, 'lobby:update', async (room, player, payload) => {
    if (room.status !== 'lobby') return error('Table settings are locked after the game starts.');
    if (room.hostId !== player.id) return error('Only the host can change table settings.');
    const maxPlayers = Number(payload.maxPlayers);
    const mafiaCount = Number(payload.mafiaCount);
    if (!Number.isInteger(maxPlayers) || maxPlayers < 5 || maxPlayers > 16) return error('Player limit must be between 5 and 16.');
    if (maxPlayers < room.players.length) return error('Player limit cannot be lower than the number of people already seated.');
    if (!Number.isInteger(mafiaCount) || mafiaCount < 1 || mafiaCount > getMafiaCap(maxPlayers)) return error(`Mafia count must be between 1 and ${getMafiaCap(maxPlayers)} for this player limit.`);
    room.settings.maxPlayers = maxPlayers;
    room.settings.mafiaCount = mafiaCount;
    await commit(room);
    return success();
  }));

  socket.on('lobby:start', withPlayer(socket, 'lobby:start', async (room, player) => {
    if (room.status !== 'lobby') return error('This game has already started.');
    if (room.hostId !== player.id) return error('Only the host can start the game.');
    if (room.players.length < 5) return error('At least five players are required to begin.');
    const mafiaCap = getMafiaCap(room.players.length);
    if (room.settings.mafiaCount > mafiaCap) return error(`With ${room.players.length} players, the maximum Mafia count is ${mafiaCap}.`);
    const shuffled = [...room.players];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = randomBytes(2).readUInt16BE(0) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    shuffled.forEach((entry, index) => {
      entry.role = index < room.settings.mafiaCount ? 'mafia' : null;
    });
    let remaining = shuffled.filter((entry) => !entry.role);
    const sheriff = remaining.splice(randomBytes(2).readUInt16BE(0) % remaining.length, 1)[0];
    sheriff.role = 'sheriff';
    const angel = remaining.splice(randomBytes(2).readUInt16BE(0) % remaining.length, 1)[0];
    angel.role = 'angel';
    remaining.forEach((entry) => { entry.role = 'citizen'; });
    room.status = 'playing';
    room.round = 1;
    room.phase = 'night';
    room.phaseEndsAt = Date.now() + NIGHT_SECONDS * 1000;
    room.actions = freshActions();
    room.tieCandidates = [];
    room.announcement = makeAnnouncement('phase', 'NIGHT 1 · THE HOUSE GOES SILENT', 'Your role has been chosen. The doors are locked. The Mafia may now choose their victim.', 'red');
    room.players.forEach((entry) => { entry.privateResults = []; });
    await commit(room);
    return success();
  }));

  socket.on('night:act', withPlayer(socket, 'night:act', async (room, player, payload) => {
    if (room.status !== 'playing' || room.phase !== 'night') return error('Night actions are not open.');
    if (!player.alive) return error('Ghosts cannot perform night actions.');
    const target = playerById(room, String(payload.targetId || ''));
    if (!target || !target.alive) return error('Choose a living player.');
    if (target.id === player.id && !canTargetSelf(player.role)) return error('You cannot choose yourself.');
    if (player.role === 'mafia') {
      room.actions.mafiaVotes[player.id] = target.id;
    } else if (player.role === 'sheriff') {
      room.actions.sheriffTarget = target.id;
    } else if (player.role === 'angel') {
      room.actions.angelTarget = target.id;
    } else {
      return error('Your role has no night action.');
    }
    const progress = getNightActionProgress(room);
    if (progress.allDone) resolveNight(room);
    await commit(room);
    return success({ submitted: true });
  }));

  socket.on('day:ready', withPlayer(socket, 'day:ready', async (room, player, payload) => {
    if (room.status !== 'playing' || room.phase !== 'discussion') return error('The discussion phase is closed.');
    if (!player.alive) return error('Ghosts cannot ready the vote.');
    room.actions.dayReady ??= {};
    if (payload.ready === false) delete room.actions.dayReady[player.id];
    else room.actions.dayReady[player.id] = true;
    const ready = Boolean(room.actions.dayReady[player.id]);
    const started = everyoneReadyForVote(room);
    if (started) beginVoting(room);
    await commit(room);
    return success({ ready, started });
  }));

  socket.on('day:vote', withPlayer(socket, 'day:vote', async (room, player, payload) => {
    if (room.status !== 'playing' || !['voting', 'tieVoting'].includes(room.phase)) return error('Voting is not open.');
    if (!player.alive) return error('Ghosts cannot vote.');
    const target = playerById(room, String(payload.targetId || ''));
    if (!target || !target.alive || target.id === player.id) return error('Choose another living player.');
    if (room.phase === 'tieVoting' && !room.tieCandidates.includes(target.id)) return error('You can only vote for one of the tied candidates.');
    room.actions.dayVotes[player.id] = target.id;
    const tieBreak = room.phase === 'tieVoting';
    if (everyoneVoted(room)) resolveDayVoting(room, tieBreak);
    await commit(room);
    return success({ submitted: true, resolved: room.phase !== (tieBreak ? 'tieVoting' : 'voting') });
  }));

  socket.on('chat:send', withPlayer(socket, 'chat:send', async (room, player, payload) => {
    if (!player.alive) return error('The dead cannot speak at the table.');
    const text = cleanMessage(payload.text);
    if (!text) return error('Write a message before sending.');
    if (!chatAllowed(player.id)) return error('Slow down. The house is listening.');
    let scope = 'public';
    if (room.phase === 'night') {
      if (player.role !== 'mafia') return error('The town is silent during the night.');
      scope = 'mafia';
    } else if (!['discussion', 'voting', 'tieVoting'].includes(room.phase)) {
      return error('Chat is closed during this phase.');
    }
    room.chat.push({ id: randomUUID(), playerId: player.id, playerName: player.name, avatar: player.avatar, text, scope, at: Date.now() });
    room.chat = room.chat.slice(-100);
    await commit(room);
    return success();
  }));

  socket.on('room:leave', withPlayer(socket, 'room:leave', async (room, player) => {
    socketByPlayer.delete(player.id);
    socket.leave(`table:${room.code}`);
    socket.data.code = null;
    socket.data.playerId = null;

    if (room.status === 'lobby') {
      room.players = room.players.filter((entry) => entry.id !== player.id);
      if (room.players.length === 0) {
        await deleteRoom(room.code);
        return success({ left: true, deleted: true });
      }
      if (room.hostId === player.id) room.hostId = room.players.find((entry) => entry.connected)?.id ?? room.players[0].id;
      await commit(room);
      return success({ left: true });
    }

    if (room.status === 'playing') {
      forfeitPlayer(room, player);
      player.connected = false;
      player.disconnectAt = Date.now();
      delete room.actions.mafiaVotes[player.id];
      delete room.actions.dayVotes[player.id];
      delete room.actions.dayReady?.[player.id];
      if (player.role === 'sheriff') room.actions.sheriffTarget = null;
      if (player.role === 'angel') room.actions.angelTarget = null;
      for (const [voterId, targetId] of Object.entries(room.actions.mafiaVotes)) {
        if (targetId === player.id) delete room.actions.mafiaVotes[voterId];
      }
      for (const [voterId, targetId] of Object.entries(room.actions.dayVotes)) {
        if (targetId === player.id) delete room.actions.dayVotes[voterId];
      }
      room.tieCandidates = room.tieCandidates.filter((candidateId) => candidateId !== player.id);
      if (room.hostId === player.id) {
        room.hostId = room.players.find((entry) => entry.connected && entry.id !== player.id)?.id ?? room.hostId;
        room.hostGraceUntil = null;
      }
      if (checkVictory(room)) {
        // The departure itself may decide the game.
      } else if (room.phase === 'night' && getNightActionProgress(room).allDone) {
        resolveNight(room);
      } else if (room.phase === 'tieVoting' && room.tieCandidates.length === 0) {
        beginNextNight(room);
        room.announcement = makeAnnouncement('no-elimination', 'THE ACCUSED HAVE VANISHED', 'The tie dissolved. No one was eliminated.', 'muted');
      } else if (room.phase === 'discussion' && everyoneReadyForVote(room)) {
        beginVoting(room);
      } else if (['voting', 'tieVoting'].includes(room.phase) && everyoneVoted(room)) {
        resolveDayVoting(room, room.phase === 'tieVoting');
      }
    } else {
      player.connected = false;
      player.disconnectAt = Date.now();
    }
    await commit(room);
    return success({ left: true });
  }));

  socket.on('disconnect', async () => {
    const { code, playerId } = socket.data;
    if (!code || !playerId) return;
    const room = rooms.get(code);
    const player = room ? playerById(room, playerId) : null;
    if (!player) return;
    if (socketByPlayer.get(playerId) && socketByPlayer.get(playerId) !== socket.id) return;
    if (socketByPlayer.get(playerId) === socket.id) socketByPlayer.delete(playerId);
    player.connected = false;
    player.disconnectAt = Date.now();
    if (room.hostId === player.id) room.hostGraceUntil = Date.now() + RECONNECT_GRACE_MS;
    await commit(room);
  });
});

app.post('/api/voice-token', async (req, res) => {
  try {
    const { code, phase } = req.body ?? {};
    const token = String(req.headers['x-player-token'] || '');
    if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
      return res.status(503).json({ error: 'Voice chat is not configured on this deployment yet.' });
    }
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room || !token) return res.status(401).json({ error: 'Your table session could not be verified.' });
    const player = room.players.find((entry) => entry.tokenHash === hashToken(token));
    if (!player || !player.alive || !player.connected) return res.status(403).json({ error: 'Only living, connected players can use voice chat.' });
    const allowedPhase = ['discussion', 'voting', 'tieVoting'].includes(room.phase)
      || (room.phase === 'night' && player.role === 'mafia');
    if (!allowedPhase) return res.status(403).json({ error: 'Voice chat is closed during this phase.' });
    const voiceRoom = room.phase === 'night' ? `hollow-${room.code}-night-${room.round}` : `hollow-${room.code}-day-${room.round}`;
    const accessToken = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
      identity: player.id,
      name: player.name,
      ttl: '15m',
    });
    accessToken.addGrant({ roomJoin: true, room: voiceRoom, canPublish: true, canSubscribe: true });
    const jwt = await accessToken.toJwt();
    res.json({ token: jwt, serverUrl: process.env.LIVEKIT_URL, room: voiceRoom });
  } catch (err) {
    console.error('LiveKit token error:', err);
    res.status(500).json({ error: 'Could not start voice chat.' });
  }
});

if (isProduction) {
  const distPath = path.resolve(__dirname, '../client/dist');
  app.use(express.static(distPath));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

await initializeDatabase();
setInterval(() => { tickRooms().catch((err) => console.error('Game clock error:', err)); }, 500);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`The Hollow Table server is listening on port ${PORT}`);
});
