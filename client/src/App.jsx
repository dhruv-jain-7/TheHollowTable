import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { request, socket } from './socket.js';
import VoiceRoom from './components/VoiceRoom.jsx';

const AVATARS = [
  { id: 'raven', face: '🐦‍⬛', label: 'Raven' },
  { id: 'skull', face: '💀', label: 'Skull' },
  { id: 'ghost', face: '👻', label: 'Ghost' },
  { id: 'bat', face: '🦇', label: 'Bat' },
  { id: 'wolf', face: '🐺', label: 'Wolf' },
  { id: 'cat', face: '🐈‍⬛', label: 'Black cat' },
  { id: 'owl', face: '🦉', label: 'Owl' },
  { id: 'spider', face: '🕷️', label: 'Spider' },
  { id: 'moth', face: '🦋', label: 'Moth' },
  { id: 'snake', face: '🐍', label: 'Serpent' },
  { id: 'candle', face: '🕯️', label: 'Candle' },
  { id: 'rose', face: '🥀', label: 'Withered rose' },
  { id: 'moon', face: '🌘', label: 'Eclipse' },
  { id: 'pumpkin', face: '🎃', label: 'Lantern' },
  { id: 'key', face: '🗝️', label: 'Old key' },
  { id: 'crow', face: '🐦', label: 'Crow' },
  { id: 'coffin', face: '⚰️', label: 'Coffin' },
  { id: 'crystal', face: '🔮', label: 'Oracle' },
  { id: 'mask', face: '🎭', label: 'Masquerade' },
  { id: 'poison', face: '⚗️', label: 'Alchemist' },
  { id: 'blackheart', face: '🖤', label: 'Black heart' },
  { id: 'eye', face: '👁️', label: 'Watcher' },
  { id: 'rose2', face: '🌹', label: 'Dark rose' },
  { id: 'moon2', face: '🌑', label: 'New moon' },
];

const ROLE_NAMES = { mafia: 'Mafia', sheriff: 'Sheriff', angel: 'Angel', citizen: 'Citizen' };
const ROLE_SIGNS = { mafia: '☠', sheriff: '⌕', angel: '✧', citizen: '♟' };

function avatarFor(id) {
  return AVATARS.find((avatar) => avatar.id === id) ?? AVATARS[0];
}

function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function phaseTitle(snapshot) {
  if (snapshot.status === 'lobby') return 'THE GUESTS ARE GATHERING';
  if (snapshot.phase === 'night') return `NIGHT ${snapshot.round} · THE MURDER HOUR`;
  if (snapshot.phase === 'discussion') return `DAY ${snapshot.round} · OPEN DISCUSSION`;
  if (snapshot.phase === 'voting') return `DAY ${snapshot.round} · ELIMINATION VOTE`;
  if (snapshot.phase === 'tieVoting') return `DAY ${snapshot.round} · THE TIE-BREAK`;
  if (snapshot.phase === 'transition') return 'THE HOUSE HOLDS ITS BREATH';
  return 'THE GAME IS OVER';
}

function phaseDescription(snapshot) {
  if (snapshot.phase === 'night') return 'The house is silent. Choose your action in secret.';
  if (snapshot.phase === 'discussion') return 'Speak carefully. Someone at this table is lying.';
  if (snapshot.phase === 'voting') return 'Choose the name that must leave the table.';
  if (snapshot.phase === 'tieVoting') return 'The vote is tied. Choose again.';
  if (snapshot.phase === 'transition') return 'The house is deciding what happens next.';
  if (snapshot.phase === 'finished') return snapshot.winner === 'mafia' ? 'The Mafia own the house.' : 'The town has survived.';
  return '';
}

function App() {
  const [snapshot, setSnapshot] = useState(null);
  const [session, setSession] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('hollow-table-session') || 'null'); }
    catch { return null; }
  });
  const [screen, setScreen] = useState('landing');
  const [errorMessage, setErrorMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [clock, setClock] = useState(Date.now());
  const [serverOffset, setServerOffset] = useState(0);
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('raven');
  const [joinCode, setJoinCode] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(10);
  const [mafiaCount, setMafiaCount] = useState(2);
  const [selectedTarget, setSelectedTarget] = useState('');
  const [messageText, setMessageText] = useState('');
  const [leaving, setLeaving] = useState(false);
  const chatEndRef = useRef(null);
  const lastResumeKey = useRef('');
  const lastPhaseKey = useRef('');

  const flash = useCallback((message, isError = false) => {
    if (isError) setErrorMessage(message);
    else setNotice(message);
    window.setTimeout(() => {
      setErrorMessage((current) => current === message ? '' : current);
      setNotice((current) => current === message ? '' : current);
    }, 4500);
  }, []);

  const saveSession = useCallback((nextSession) => {
    setSession(nextSession);
    if (nextSession) sessionStorage.setItem('hollow-table-session', JSON.stringify(nextSession));
    else sessionStorage.removeItem('hollow-table-session');
  }, []);

  useEffect(() => {
    const onState = (nextSnapshot) => {
      const phaseKey = `${nextSnapshot.status}:${nextSnapshot.phase}:${nextSnapshot.round}:${(nextSnapshot.tieCandidates || []).map((item) => item.id).join(',')}`;
      if (lastPhaseKey.current !== phaseKey) setSelectedTarget('');
      lastPhaseKey.current = phaseKey;
      if (Number.isFinite(nextSnapshot.serverNow)) setServerOffset(nextSnapshot.serverNow - Date.now());
      setSnapshot(nextSnapshot);
      setScreen(nextSnapshot.status === 'lobby' ? 'lobby' : 'game');
    };
    const onReplaced = () => {
      saveSession(null);
      setSnapshot(null);
      setScreen('landing');
      flash('This seat was opened on another device. This tab has been signed out.', true);
    };
    const onKicked = (payload = {}) => {
      saveSession(null);
      setSnapshot(null);
      setScreen('landing');
      setSelectedTarget('');
      flash(payload.reason || 'The host removed your seat from this table.', true);
    };
    const onConnect = async () => {
      if (!session?.code || !session?.token) return;
      const resumeKey = `${socket.id}:${session.code}:${session.token}`;
      if (lastResumeKey.current === resumeKey) return;
      lastResumeKey.current = resumeKey;
      const response = await request('room:resume', session);
      if (response.ok) {
        if (response.snapshot) setSnapshot(response.snapshot);
      } else if (response.error === 'Saved table session not found.' || response.error === 'This reconnect code is no longer valid.') {
        saveSession(null);
        setSnapshot(null);
        setScreen('landing');
      } else {
        lastResumeKey.current = '';
        flash(response.error || 'Could not reconnect to the table.', true);
      }
    };
    socket.on('room:state', onState);
    socket.on('session:replaced', onReplaced);
    socket.on('session:kicked', onKicked);
    socket.on('connect', onConnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off('room:state', onState);
      socket.off('session:replaced', onReplaced);
      socket.off('session:kicked', onKicked);
      socket.off('connect', onConnect);
    };
  }, [session, saveSession, flash]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [snapshot?.chat?.length]);

  const createTable = async () => {
    setErrorMessage('');
    if (name.trim().length < 2) return flash('Enter a nickname with at least two characters.', true);
    setBusy(true);
    const response = await request('room:create', { name, avatar, maxPlayers });
    setBusy(false);
    if (!response.ok) return flash(response.error, true);
    saveSession({ code: response.code, token: response.token });
    setSnapshot(response.snapshot);
    setScreen('lobby');
  };

  const joinTable = async () => {
    setErrorMessage('');
    if (name.trim().length < 2) return flash('Enter a nickname with at least two characters.', true);
    if (!/^[A-HJ-NP-Z2-9]{4}$/.test(joinCode.trim().toUpperCase())) return flash('Enter the four-character table code.', true);
    setBusy(true);
    const response = await request('room:join', { code: joinCode, name, avatar });
    setBusy(false);
    if (!response.ok) return flash(response.error, true);
    saveSession({ code: response.code, token: response.token });
    setSnapshot(response.snapshot);
    setScreen('lobby');
  };

  const updateLobby = async (nextMaxPlayers, nextMafiaCount) => {
    setMaxPlayers(nextMaxPlayers);
    setMafiaCount(nextMafiaCount);
    const response = await request('lobby:update', { maxPlayers: nextMaxPlayers, mafiaCount: nextMafiaCount });
    if (!response.ok) flash(response.error, true);
    return response;
  };

  const startGame = async () => {
    setBusy(true);
    const response = await request('lobby:start');
    setBusy(false);
    if (!response.ok) flash(response.error, true);
  };

  const kickPlayer = async (player) => {
    if (!snapshot?.me?.isHost || !player || player.id === snapshot.me.id) return;
    const action = snapshot.status === "playing" ? "forfeit this player's seat in the current game" : "remove this guest from the lobby";
    if (!window.confirm(`Remove ${player.name}? This will ${action}.`)) return;
    const response = await request('room:kick', { playerId: player.id });
    if (!response?.ok) flash(response?.error || 'Could not remove this guest.', true);
    else flash(`${player.name} was removed from the table.`);
  };

  const leaveTable = async () => {
    if (snapshot?.status === 'playing' && !window.confirm('Leaving now counts as abandoning your seat. Your character will be removed from the living players. Continue?')) return;
    setLeaving(true);
    const response = await request('room:leave');
    if (!response?.ok) {
      setLeaving(false);
      flash(response?.error || 'Could not leave the table. Please try again.', true);
      return;
    }
    saveSession(null);
    setSnapshot(null);
    setScreen('landing');
    setLeaving(false);
    setSelectedTarget('');
    lastPhaseKey.current = '';
  };

  const sendChat = async (event) => {
    event.preventDefault();
    if (!messageText.trim()) return;
    const response = await request('chat:send', { text: messageText });
    if (!response.ok) flash(response.error, true);
    else setMessageText('');
  };

  const actNight = async () => {
    if (!selectedTarget) return flash('Choose a player first.', true);
    const response = await request('night:act', { targetId: selectedTarget });
    if (!response.ok) flash(response.error, true);
    else flash('Your night action has been recorded.');
  };

  const vote = async () => {
    if (!selectedTarget) return flash('Choose a player first.', true);
    const response = await request('day:vote', { targetId: selectedTarget });
    if (!response.ok) flash(response.error, true);
    else flash('Vote recorded.');
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(snapshot.code);
      flash('Table code copied. Invite your guests.');
    } catch {
      flash(`Your table code is ${snapshot.code}`);
    }
  };

  const countdown = snapshot?.phaseEndsAt ? snapshot.phaseEndsAt - (clock + serverOffset) : null;

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <div className="grain-overlay" />
      <header className="topbar">
        <button className="brand-lockup" onClick={() => snapshot ? null : setScreen('landing')} aria-label="The Hollow Table home">
          <span className="brand-mark">✦</span>
          <span><strong>THE HOLLOW TABLE</strong><small>AN ONLINE SOCIAL DEDUCTION GAME</small></span>
        </button>
        <div className="topbar-right">
          <span className="online-indicator"><i /> {socket.connected ? 'SERVER CONNECTED' : 'RECONNECTING'}</span>
          {snapshot && <button className="quiet-button" onClick={leaveTable} disabled={leaving}>{leaving ? 'LEAVING…' : 'LEAVE TABLE'}</button>}
        </div>
      </header>

      {(errorMessage || notice) && <div className={`toast ${errorMessage ? 'toast-error' : 'toast-good'}`}>{errorMessage || notice}</div>}

      {!snapshot && (
        <Landing
          name={name} setName={setName}
          avatar={avatar} setAvatar={setAvatar}
          joinCode={joinCode} setJoinCode={setJoinCode}
          maxPlayers={maxPlayers} setMaxPlayers={(value) => { setMaxPlayers(value); setMafiaCount((current) => Math.min(current, Math.max(1, Math.floor((value - 1) / 2)))); }}
          createTable={createTable} joinTable={joinTable} busy={busy}
        />
      )}

      {snapshot?.status === 'lobby' && (
        <Lobby
          snapshot={snapshot}
          maxPlayers={snapshot.settings.maxPlayers}
          mafiaCount={snapshot.settings.mafiaCount}
          onUpdate={updateLobby}
          onStart={startGame}
          busy={busy}
          onCopy={copyCode}
          onKickPlayer={kickPlayer}
        />
      )}

      {snapshot?.status === 'playing' && (
        <Game
          snapshot={snapshot}
          countdown={countdown}
          selectedTarget={selectedTarget}
          setSelectedTarget={setSelectedTarget}
          actNight={actNight}
          vote={vote}
          messageText={messageText}
          setMessageText={setMessageText}
          sendChat={sendChat}
          chatEndRef={chatEndRef}
          session={session}
          clock={clock}
          serverOffset={serverOffset}
          onKickPlayer={kickPlayer}
        />
      )}

      {snapshot?.status === 'finished' && (
        <EndGame snapshot={snapshot} onLeave={leaveTable} />
      )}

      <footer className="site-footer">
        <span>NO ONE IS INNOCENT AFTER MIDNIGHT.</span>
        <span>PRIVATE TABLES · {snapshot?.code || 'INVITE ONLY'}</span>
      </footer>
    </main>
  );
}

function AvatarPicker({ selected, onSelect }) {
  return (
    <div className="avatar-picker">
      {AVATARS.map((item, index) => (
        <button
          type="button"
          key={item.id}
          title={item.label}
          aria-label={`Choose ${item.label} avatar`}
          className={`avatar-option avatar-tone-${index % 6} ${selected === item.id ? 'selected' : ''}`}
          onClick={() => onSelect(item.id)}
        >
          <span>{item.face}</span>
        </button>
      ))}
    </div>
  );
}

function Landing({ name, setName, avatar, setAvatar, joinCode, setJoinCode, maxPlayers, setMaxPlayers, createTable, joinTable, busy }) {
  const [mode, setMode] = useState('create');
  return (
    <section className="landing-layout">
      <div className="landing-copy">
        <div className="eyebrow"><span /> THE HOUSE IS WAITING <span /></div>
        <h1>Some secrets<br /><em>never stay buried.</em></h1>
        <p className="landing-lede">Gather your circle. Take your seat. Find the liar before the house claims you all.</p>
        <div className="landing-features">
          <div><b>01</b><span>PRIVATE TABLES<br /><small>Four-character invite code</small></span></div>
          <div><b>02</b><span>SECRET ROLES<br /><small>Mafia, Sheriff, Angel, Citizen</small></span></div>
          <div><b>03</b><span>LIVE GAMEPLAY<br /><small>Discuss, investigate, vote</small></span></div>
        </div>
        <div className="quote-mark">“</div>
        <p className="whisper">Trust the silence. Fear the familiar.</p>
      </div>

      <section className="entry-card">
        <div className="card-topline"><span>✦</span> YOUR NIGHT BEGINS HERE <span>✦</span></div>
        <div className="entry-tabs">
          <button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>CREATE TABLE</button>
          <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>JOIN TABLE</button>
        </div>
        <label className="field-label">YOUR NAME</label>
        <input className="dark-input" value={name} onChange={(event) => setName(event.target.value.slice(0, 18))} placeholder="Enter your nickname" maxLength={18} />
        <div className="picker-heading"><span className="field-label">CHOOSE YOUR PORTRAIT</span><small>24 portraits</small></div>
        <AvatarPicker selected={avatar} onSelect={setAvatar} />
        {mode === 'create' ? (
          <>
            <div className="setting-row"><span className="field-label">TABLE CAPACITY</span><strong>{maxPlayers} PLAYERS</strong></div>
            <input className="range-input" type="range" min="5" max="16" value={maxPlayers} onChange={(event) => setMaxPlayers(Number(event.target.value))} />
            <div className="range-labels"><span>5 MIN</span><span>16 MAX</span></div>
            <button className="primary-button full-button" onClick={createTable} disabled={busy}>{busy ? 'OPENING THE HOUSE…' : 'CREATE A PRIVATE TABLE'} <span>↗</span></button>
          </>
        ) : (
          <>
            <label className="field-label" htmlFor="table-code">FOUR-CHARACTER TABLE CODE</label>
            <input id="table-code" className="dark-input code-input" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 4))} placeholder="X7K9" maxLength={4} />
            <button className="primary-button full-button" onClick={joinTable} disabled={busy}>{busy ? 'FINDING YOUR TABLE…' : 'TAKE YOUR SEAT'} <span>↗</span></button>
          </>
        )}
        <p className="privacy-note"><span>♙</span> Private by code. No public matchmaking. No account required.</p>
      </section>
    </section>
  );
}

function Lobby({ snapshot, maxPlayers, mafiaCount, onUpdate, onStart, busy, onCopy, onKickPlayer }) {
  const isHost = snapshot.me.isHost;
  const actualCap = Math.max(1, Math.floor((snapshot.players.length - 1) / 2));
  const canStart = snapshot.players.length >= 5 && mafiaCount <= actualCap;
  const [localMax, setLocalMax] = useState(maxPlayers);
  const [localMafia, setLocalMafia] = useState(mafiaCount);
  useEffect(() => { setLocalMax(maxPlayers); }, [maxPlayers]);
  useEffect(() => { setLocalMafia(mafiaCount); }, [mafiaCount]);

  const saveSettings = async (nextMax, nextMafia) => {
    const response = await onUpdate(nextMax, nextMafia);
    if (!response?.ok) {
      setLocalMax(maxPlayers);
      setLocalMafia(mafiaCount);
    }
  };
  const changeMax = (value) => {
    const nextMax = Number(value);
    const nextMafia = Math.min(localMafia, Math.max(1, Math.floor((nextMax - 1) / 2)));
    setLocalMax(nextMax);
    setLocalMafia(nextMafia);
    saveSettings(nextMax, nextMafia);
  };
  const changeMafia = (value) => {
    setLocalMafia(Number(value));
    saveSettings(localMax, Number(value));
  };

  return (
    <section className="lobby-layout">
      <div className="lobby-heading">
        <div className="eyebrow"><span /> THE GUESTS ARE GATHERING <span /></div>
        <h1>Take your <em>seat.</em></h1>
        <p>Invite your circle. When at least five souls have arrived, the host may begin.</p>
      </div>
      <div className="lobby-grid">
        <section className="panel code-panel">
          <div className="panel-kicker">YOUR PRIVATE TABLE CODE</div>
          <div className="code-display">{snapshot.code.split('').map((letter, index) => <span key={index}>{letter}</span>)}</div>
          <button className="outline-button copy-button" onClick={onCopy}>▣ COPY INVITE CODE</button>
          <div className="code-footnote">Only guests with this code can enter.</div>
        </section>
        <section className="panel guest-panel">
          <div className="panel-header"><div><div className="panel-kicker">THE GUEST LIST</div><h2>At the table <span>{snapshot.players.length}/{snapshot.settings.maxPlayers}</span></h2></div><span className="panel-symbol">♜</span></div>
          <div className="guest-list">
            {snapshot.players.map((player, index) => (
              <div className="guest-row" key={player.id}>
                <div className={`mini-avatar avatar-tone-${index % 6}`}>{avatarFor(player.avatar).face}</div>
                <div className="guest-name">{player.name}{player.isHost && <small>HOST</small>}</div>
                <span className={`guest-status ${player.connected ? 'connected' : ''}`}><i /> {player.connected ? 'HERE' : 'RECONNECTING'}</span>
                {isHost && player.id !== snapshot.me.id && <button className="host-kick-button" onClick={() => onKickPlayer(player)} title={`Remove ${player.name}`}>REMOVE</button>}
              </div>
            ))}
            {Array.from({ length: Math.max(0, Math.min(6, snapshot.settings.maxPlayers - snapshot.players.length)) }).map((_, index) => (
              <div className="guest-row empty-seat" key={`empty-${index}`}><div className="mini-avatar">?</div><div className="guest-name">Awaiting a guest</div><span>EMPTY SEAT</span></div>
            ))}
          </div>
        </section>
        <section className="panel settings-panel">
          <div className="panel-header"><div><div className="panel-kicker">THE HOUSE RULES</div><h2>Game settings</h2></div><span className="panel-symbol">⚙</span></div>
          {isHost ? (
            <>
              <div className="setting-block"><div className="setting-row"><label>Maximum guests</label><strong>{localMax}</strong></div><input className="range-input" type="range" min="5" max="16" value={localMax} onChange={(event) => changeMax(event.target.value)} /></div>
              <div className="setting-block"><div className="setting-row"><label>Mafia members</label><strong>{localMafia}</strong></div><input className="range-input" type="range" min="1" max={Math.max(1, Math.floor((localMax - 1) / 2))} value={localMafia} onChange={(event) => changeMafia(event.target.value)} /></div>
              <div className="fixed-roles"><span><b>1</b> SHERIFF</span><span><b>1</b> ANGEL</span><span><b>4 MIN</b> DISCUSSION FLOOR</span></div>
              {snapshot.players.length >= 5 && mafiaCount > actualCap && <p className="warning-note">With {snapshot.players.length} players, reduce Mafia to {actualCap} or fewer before starting.</p>}
              <button className="primary-button full-button start-button" onClick={onStart} disabled={busy || !canStart}>{busy ? 'AWAKENING THE HOUSE…' : 'BEGIN THE GAME'} <span>↗</span></button>
              <p className="host-note">You are the host. Roles are assigned secretly by the server.</p>
            </>
          ) : (
            <div className="waiting-host"><div className="waiting-orbit">✧</div><h3>Waiting for the host</h3><p>The host is preparing the house rules. The game begins when at least five guests have arrived.</p><div className="fixed-roles"><span><b>1</b> SHERIFF</span><span><b>1</b> ANGEL</span></div></div>
          )}
        </section>
      </div>
      <div className="lobby-bottom-note"><span>✦</span> Once the game begins, no new guests may enter. <span>✦</span></div>
    </section>
  );
}

function MurderOverlay({ announcement }) {
  if (!announcement) return null;
  return (
    <div className="murder-overlay" key={announcement.id} aria-live="assertive">
      <div className="murder-red-flash" />
      <div className="murder-blood-burst" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>
      <div className="murder-knife" aria-hidden="true">
        <svg viewBox="0 0 180 420">
          <defs><linearGradient id="knifeSteel" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff0db" /><stop offset=".45" stopColor="#aeb4ba" /><stop offset="1" stopColor="#4d5158" /></linearGradient></defs>
          <path d="M90 8 L137 220 L90 275 L43 220 Z" fill="url(#knifeSteel)" stroke="#d9d0c7" strokeWidth="4" />
          <path d="M90 275V385" stroke="#39201b" strokeWidth="30" strokeLinecap="round" />
          <path d="M49 292H131" stroke="#a77b4f" strokeWidth="18" strokeLinecap="round" />
          <path d="M90 287V378" stroke="#8b4b37" strokeWidth="5" />
        </svg>
      </div>
      <div className="murder-reveal-text">
        <span>THE HOUSE HAS TAKEN</span>
        <strong>{announcement.victimName || 'A PLAYER'}</strong>
        <em>HAS BEEN MURDERED</em>
      </div>
    </div>
  );
}


const VOTE_TABLE_MS = 6200;
const ELIMINATION_VERDICT_END_MS = 10800;
const NO_ELIMINATION_VERDICT_END_MS = 8500;

function TypewriterText({ text, className = '', speed = 62 }) {
  const [visibleText, setVisibleText] = useState('');
  useEffect(() => {
    setVisibleText('');
    if (!text) return undefined;
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setVisibleText(text.slice(0, index));
      if (index >= text.length) window.clearInterval(timer);
    }, speed);
    return () => window.clearInterval(timer);
  }, [text, speed]);
  return <span className={className}>{visibleText}</span>;
}

function CinematicTransition({ transition, announcement, voteReveal, elapsed }) {
  if (!transition) return null;
  const kind = transition.kind;
  const victimName = transition.victimName || announcement?.victimName || 'A PLAYER';
  const victimAvatar = avatarFor(transition.victimAvatar || announcement?.victimAvatar);

  if (kind === 'murder') {
    return (
      <div className="cinematic-overlay cinematic-murder" role="alert" aria-live="assertive">
        <div className="cinematic-blood-wash" />
        <div className="cinematic-skull" aria-hidden="true">☠</div>
        <div className="cinematic-knife" aria-hidden="true"><svg viewBox="0 0 120 360" role="presentation"><path d="M60 4 L94 207 L60 250 L26 207 Z" fill="#d7dce0" stroke="#f1e9e2" strokeWidth="4"/><path d="M60 250V340" stroke="#38201c" strokeWidth="25" strokeLinecap="round"/><path d="M30 267H90" stroke="#b58a5a" strokeWidth="17" strokeLinecap="round"/><path d="M60 259V332" stroke="#8f4a39" strokeWidth="4"/></svg></div>
        <div className="cinematic-content">
          <span className="cinematic-prelude"><TypewriterText key={transition.id + '-prelude'} text="THE HOUSE HAS GONE SILENT…" speed={82}/></span>
          <div className="cinematic-victim-avatar">{victimAvatar.face}</div>
          {elapsed >= 1100 && <h1 className="cinematic-title"><TypewriterText key={transition.id + '-victim'} text={`${victimName.toUpperCase()} IS MURDERED!`} speed={72}/></h1>}
          <p className="cinematic-subline">NO ONE HEARD THE FINAL FOOTSTEP.</p>
        </div>
      </div>
    );
  }

  if (kind === 'quiet') {
    return (
      <div className="cinematic-overlay cinematic-quiet" role="status" aria-live="polite">
        <div className="cinematic-blood-wash"/><div className="cinematic-skull" aria-hidden="true">☠</div>
        <div className="cinematic-content"><span className="cinematic-prelude">THE DOORS OPEN AT DAWN</span><h1 className="cinematic-title"><TypewriterText key={transition.id + '-quiet'} text="IT WAS A QUIET NIGHT" speed={72}/></h1><p className="cinematic-subline">NO ONE WAS TAKEN. THE HOUSE KEEPS ITS SECRET.</p></div>
      </div>
    );
  }

  const rows = voteReveal?.rows ?? [];
  const showingVotes = elapsed < VOTE_TABLE_MS;
  const showingVerdict = kind === 'elimination' ? elapsed >= VOTE_TABLE_MS && elapsed < ELIMINATION_VERDICT_END_MS
    : kind === 'tie' ? elapsed >= VOTE_TABLE_MS && elapsed < (transition.durationMs - 1200)
      : kind === 'no-elimination' ? elapsed >= VOTE_TABLE_MS && elapsed < NO_ELIMINATION_VERDICT_END_MS : false;
  const showingSleep = !showingVotes && !showingVerdict;

  return (
    <div className={`cinematic-overlay cinematic-${showingVotes ? 'votes' : showingSleep ? 'sleep' : 'verdict'}`} role="alert" aria-live="assertive">
      <div className="cinematic-blood-wash"/><div className="cinematic-skull" aria-hidden="true">☠</div>
      {showingVotes ? (
        <div className="vote-reveal-panel">
          <span className="cinematic-prelude">THE ELIMINATION VOTE IS COMPLETE</span>
          <h1 className="vote-reveal-title">WHO VOTED FOR WHOM</h1>
          <div className="vote-reveal-head"><span>PLAYER</span><span>VOTED AGAINST</span></div>
          <div className="vote-reveal-list">
            {rows.map((row, index) => (
              <div className="vote-reveal-row" key={row.voterId} style={{'--row-delay': `${Math.min(index * 220, 3300)}ms`}}>
                <div className="vote-person"><span>{avatarFor(row.voterAvatar).face}</span><strong>{row.voterName}</strong></div>
                <div className="vote-target"><span>{row.targetName ? avatarFor(row.targetAvatar).face : '—'}</span><strong>{row.targetName || 'DID NOT VOTE'}</strong></div>
              </div>
            ))}
            {rows.length === 0 && <div className="vote-reveal-empty">NO VOTES WERE CAST.</div>}
          </div>
        </div>
      ) : showingVerdict ? (
        <div className="cinematic-content">
          {kind === 'elimination' ? <><span className="cinematic-prelude">THE TABLE HAS MADE ITS CHOICE</span><div className="cinematic-victim-avatar">{victimAvatar.face}</div><h1 className="cinematic-title"><TypewriterText key={transition.id + '-elimination'} text={`${victimName.toUpperCase()} IS ELIMINATED!`} speed={74}/></h1><p className="cinematic-subline">THEIR SEAT WILL REMAIN EMPTY.</p></>
            : kind === 'tie' ? <><span className="cinematic-prelude">THE TABLE CANNOT AGREE</span><h1 className="cinematic-title"><TypewriterText key={transition.id + '-tie'} text="THE VOTE IS TIED" speed={72}/></h1><p className="cinematic-subline">THE ACCUSED WILL FACE ONE FINAL VOTE.</p></>
              : <><span className="cinematic-prelude">THE BALLOTS HAVE BEEN COUNTED</span><h1 className="cinematic-title"><TypewriterText key={transition.id + '-none'} text="NO ONE IS ELIMINATED" speed={72}/></h1><p className="cinematic-subline">THE HOUSE HAS ACCEPTED NO VERDICT.</p></>}
        </div>
      ) : (
        <div className="cinematic-content cinematic-sleep-content"><span className="cinematic-prelude">THE CANDLES ARE GOING OUT</span><h1 className="cinematic-title"><TypewriterText key={transition.id + '-sleep'} text="TOWN, SLEEP." speed={95}/></h1><p className="cinematic-subline">THE NIGHT BELONGS TO THE HOUSE.</p></div>
      )}
    </div>
  );
}

function SheriffRevealOverlay({ result }) {
  if (!result) return null;
  return (
    <div className={`sheriff-reveal-overlay ${result.kind === 'danger' ? 'sheriff-result-danger' : 'sheriff-result-safe'}`} role="alert" aria-live="assertive">
      <div className="cinematic-skull" aria-hidden="true">☠</div>
      <span>PRIVATE INVESTIGATION</span>
      <div className="sheriff-target-avatar">{avatarFor(result.targetAvatar).face}</div>
      <h2><TypewriterText key={result.id} text={result.text.toUpperCase()} speed={48}/></h2>
      <p>ONLY YOU CAN SEE THIS RESULT</p>
    </div>
  );
}

function Game({ snapshot, countdown, selectedTarget, setSelectedTarget, actNight, vote, messageText, setMessageText, sendChat, chatEndRef, session, clock, serverOffset, onKickPlayer }) {
  const isNight = snapshot.phase === 'night';
  const isDiscussion = snapshot.phase === 'discussion';
  const isVoting = snapshot.phase === 'voting';
  const isTie = snapshot.phase === 'tieVoting';
  const isTransition = snapshot.phase === 'transition';
  const transitionElapsed = snapshot.transition?.startedAt ? Math.max(0, clock + serverOffset - snapshot.transition.startedAt) : 0;
  const isRoleAction = isNight && ['mafia', 'sheriff', 'angel'].includes(snapshot.me.role);
  const isVotePhase = isVoting || isTie;
  const phaseTimer = countdown == null ? '—' : formatTime(countdown);
  const alivePlayers = snapshot.players.filter((player) => player.alive);
  const targetPlayers = alivePlayers.filter((player) => (player.id !== snapshot.me.id || (isNight && ['angel', 'mafia'].includes(snapshot.me.role))) && (!isTie || snapshot.tieCandidates.some((candidate) => candidate.id === player.id)));
  const voiceEnabled = snapshot.me.alive && (isDiscussion || isTie || (isNight && snapshot.me.role === 'mafia'));
  const [identityVisible, setIdentityVisible] = useState(true);
  const [sheriffReveal, setSheriffReveal] = useState(null);
  const seenSheriffResultRef = useRef(snapshot.me.privateResults?.[0]?.id || null);

  useEffect(() => {
    const timer = window.setTimeout(() => setIdentityVisible(false), 8500);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const latestResult = snapshot.me.privateResults?.[0];
    if (snapshot.me.role !== 'sheriff' || !latestResult || latestResult.id === seenSheriffResultRef.current) return undefined;
    seenSheriffResultRef.current = latestResult.id;
    setSheriffReveal(latestResult);
    const timer = window.setTimeout(() => setSheriffReveal(null), 2800);
    return () => window.clearTimeout(timer);
  }, [snapshot.me.privateResults?.[0]?.id, snapshot.me.role]);

  const timerUrgent = countdown != null && countdown < 60_000;
  const chatTitle = isNight ? 'THE WHISPERS' : 'THE TABLE WHISPERS';

  const ringPlayers = useMemo(() => snapshot.players.map((player, index) => {
    const angle = (Math.PI * 2 * index) / snapshot.players.length - Math.PI / 2;
    return { ...player, x: 50 + Math.cos(angle) * 39, y: 50 + Math.sin(angle) * 40 };
  }), [snapshot.players]);

  return (
    <section className="game-layout">
      <div className="game-topline">
        <div><span className="room-pill">TABLE {snapshot.code}</span><span className="round-pill">ROUND {snapshot.round}</span></div>
        {!isTransition && <div className={`phase-clock ${timerUrgent ? 'urgent' : ''}`}><small>{snapshot.phase === 'night' ? 'NIGHT ENDS IN' : snapshot.phase === 'discussion' ? 'DISCUSSION ENDS IN' : snapshot.phase === 'tieVoting' ? 'RECONSIDERATION ENDS IN' : 'VOTING ENDS IN'}</small><strong>{phaseTimer}</strong></div>}
      </div>
      <div className="game-heading"><div className="eyebrow"><span /> {snapshot.phase === 'night' ? 'THE HOUSE HOLDS ITS BREATH' : 'THE LIVING HAVE THE FLOOR'} <span /></div><h1>{phaseTitle(snapshot)}</h1><p>{phaseDescription(snapshot)}</p></div>

      {snapshot.announcement && !isTransition && (
        <div key={snapshot.announcement.id} className={`announcement announcement-${snapshot.announcement.accent || 'red'}`}>
          <div className="announcement-side">✦</div>
          <div><div className="announcement-kicker">{snapshot.announcement.kind === 'murder' ? 'MURDER REPORT' : snapshot.announcement.kind === 'elimination' ? 'ELIMINATION REPORT' : snapshot.announcement.kind === 'departure' ? 'DEPARTURE REPORT' : 'A MESSAGE FROM THE HOUSE'}</div><h2>{snapshot.announcement.title}</h2><p className="typewriter-text">{snapshot.announcement.text}</p></div>
          <div className="announcement-side">✦</div>
        </div>
      )}

      {isTransition && <CinematicTransition transition={snapshot.transition} announcement={snapshot.announcement} voteReveal={snapshot.voteReveal} elapsed={transitionElapsed} />}
      {sheriffReveal && <SheriffRevealOverlay result={sheriffReveal} />}

      {snapshot.me.role === 'mafia' && snapshot.me.alive && identityVisible && (
        <section className="mafia-stage-intel" aria-label="Private Mafia team">
          <div className="mafia-stage-heading"><small>CLASSIFIED · MAFIA ONLY</small><strong>THE INNER CIRCLE</strong><span>{snapshot.me.mafiaTeam.length} IN THE HOUSE</span></div>
          <div className="mafia-stage-members">
            {snapshot.me.mafiaTeam.map((member) => (
              <div className={`mafia-stage-member ${member.alive ? '' : 'member-fallen'}`} key={member.id}>
                <span className="mafia-stage-avatar">{avatarFor(member.avatar).face}</span>
                <span><strong>{member.name}{member.id === snapshot.me.id ? ' · YOU' : ''}</strong><small>{member.alive ? 'IN THE HUNT' : 'FALLEN'}</small></span>
              </div>
            ))}
          </div>
          {isNight && snapshot.actionProgress?.conflicting && <p className="mafia-conflict-note">CONFLICTING TARGETS · THE HOUSE MAY GRANT ONE 15-SECOND EXTENSION</p>}
          {isNight && snapshot.actionProgress?.conflictExtensionUsed && <p className="mafia-conflict-note">THE EXTRA 15 SECONDS HAVE BEEN GRANTED</p>}
        </section>
      )}

      <div className="game-main-grid">
        <section className={`table-stage ${isNight ? 'table-night' : ''}`}>
          <div className="haunted-mansion" aria-hidden="true">
            <svg viewBox="0 0 900 360" preserveAspectRatio="xMidYMid slice">
              <defs>
                <linearGradient id="bungalowSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#08070d"/><stop offset=".62" stopColor="#1d1017"/><stop offset="1" stopColor="#090708"/></linearGradient>
                <radialGradient id="bungalowMoon"><stop offset="0" stopColor="#e8cdb0" stopOpacity=".58"/><stop offset="1" stopColor="#bb7e73" stopOpacity="0"/></radialGradient>
                <linearGradient id="bungalowWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#40302d"/><stop offset="1" stopColor="#120e11"/></linearGradient>
                <filter id="windowGlow"><feGaussianBlur stdDeviation="7"/></filter>
              </defs>
              <rect width="900" height="360" fill="url(#bungalowSky)"/>
              <circle cx="710" cy="80" r="110" fill="url(#bungalowMoon)"/>
              <circle cx="710" cy="80" r="37" fill="#c9ad98" opacity=".23"/>
              <path d="M0 230Q130 190 265 235T520 218T900 218V360H0Z" fill="#080709"/>
              <g fill="#070609" stroke="#20141a" strokeWidth="4">
                <path d="M0 280V103L36 55L72 103V280ZM20 124L36 88L54 124V280H20Z"/>
                <path d="M825 290V82L864 25L900 82V290Z"/>
                <path d="M94 295V155L128 99L160 155V295Z"/>
                <path d="M760 296V170L790 120L820 170V296Z"/>
              </g>
              <g fill="#1a1116" stroke="#4a292e" strokeWidth="5">
                <path d="M208 190L450 42L692 190V323H208Z"/>
                <path d="M177 190L450 20L723 190L694 204L450 62L205 204Z" fill="#0c090d" stroke="#6e343b" strokeWidth="8"/>
                <path d="M270 192V118L450 72L630 118V192Z" fill="#24171c"/>
                <path d="M300 192V145L450 105L600 145V192Z" fill="#0b080c" stroke="#78464a" strokeWidth="3"/>
                <path d="M246 194H654V324H246Z" fill="url(#bungalowWall)"/>
                <path d="M390 324V235Q450 185 510 235V324Z" fill="#09070a" stroke="#9a6252" strokeWidth="5"/>
                <path d="M414 324V247Q450 212 486 247V324Z" fill="#1c1016" stroke="#4c282d" strokeWidth="3"/>
                <path d="M190 195H710V211H190Z" fill="#100b10" stroke="#4c292f" strokeWidth="3"/>
              </g>
              <g fill="#a34b43" opacity=".9" filter="url(#windowGlow)">
                <rect x="286" y="216" width="48" height="53"/><rect x="566" y="216" width="48" height="53"/>
                <rect x="390" y="142" width="34" height="39"/><rect x="476" y="142" width="34" height="39"/>
              </g>
              <g fill="#d58a62" opacity=".5">
                <rect x="292" y="220" width="36" height="45"/><rect x="572" y="220" width="36" height="45"/>
                <rect x="395" y="146" width="25" height="31"/><rect x="481" y="146" width="25" height="31"/>
              </g>
              <g fill="#080609" stroke="#593038" strokeWidth="3">
                <path d="M352 326V292L450 251L548 292V326Z"/>
                <path d="M80 320L82 266L101 255L119 266L121 320ZM760 323L764 271L783 260L801 271L805 323Z"/>
                <path d="M130 328L137 295L145 328ZM700 330L707 294L715 330Z"/>
              </g>
              <g fill="#b84746" opacity=".7">
                <path d="M0 326Q130 295 245 330T490 323T720 330T900 318V360H0Z"/>
                <path d="M377 360Q450 308 523 360Z" fill="#0b080a"/>
              </g>
              <g fill="none" stroke="#bb7772" strokeOpacity=".13" strokeWidth="20">
                <path d="M-30 280Q100 235 250 281T550 275T930 270"/>
                <path d="M-30 324Q130 285 270 325T560 320T930 316"/>
              </g>
            </svg>
          </div>
          <div className="table-haze haze-a" /><div className="table-haze haze-b" />
          <div className="seat-ring">
            {ringPlayers.map((player) => (
              <button
                key={player.id}
                className={`seat ${!player.alive ? 'seat-dead' : ''} ${!player.connected ? 'seat-away' : ''} ${player.id === snapshot.me.id ? 'seat-you' : ''} ${selectedTarget === player.id ? 'seat-selected' : ''} ${targetPlayers.some((target) => target.id === player.id) && (isRoleAction || isVotePhase) ? 'seat-targetable' : ''}`}
                style={{ left: `${player.x}%`, top: `${player.y}%` }}
                onClick={() => {
                  if (targetPlayers.some((target) => target.id === player.id) && (isRoleAction || isVotePhase)) setSelectedTarget(player.id);
                }}
                disabled={!targetPlayers.some((target) => target.id === player.id) || (!isRoleAction && !isVotePhase)}
                title={player.name}
              >
                <span className={`seat-avatar avatar-tone-${snapshot.players.findIndex((item) => item.id === player.id) % 6}`}>{avatarFor(player.avatar).face}</span>
                <span className="seat-name">{player.name}{player.id === snapshot.me.id ? ' · YOU' : ''}</span>
                <span className="seat-role">{!player.alive ? (ROLE_NAMES[player.role] || 'GHOST') : !player.connected ? 'AWAY' : player.isHost ? 'HOST' : 'SEATED'}</span>
                {selectedTarget === player.id && <span className="target-mark">✦</span>}
              </button>
            ))}
          </div>
          <div className="round-table">
            <div className="table-engraving">✦</div>
            <div className="table-name">THE HOLLOW<br /><em>TABLE</em></div>
            <div className="table-center-line" />
            <div className="table-candles"><i /><i /><i /></div>
            <span className="table-center-caption">{isNight ? 'THE MURDER HOUR' : 'SPEAK THE TRUTH'}</span>
          </div>
          <div className="table-floor-label">{snapshot.players.filter((player) => player.alive).length} SOULS REMAIN</div>
        </section>

        <aside className="game-sidebar">
          <div className="identity-wrap">
            <button className="identity-toggle" onClick={() => setIdentityVisible((current) => !current)}>
              <span aria-hidden="true">{identityVisible ? '◉' : '◈'}</span>
              {identityVisible ? 'HIDE YOUR IDENTITY' : 'CHECK YOUR IDENTITY'}
            </button>
            {identityVisible && <section className="panel role-panel">
            <div className={`role-medallion role-${snapshot.me.role || 'citizen'}`}>{ROLE_SIGNS[snapshot.me.role] || '♟'}</div>
            <h2>{ROLE_NAMES[snapshot.me.role] || 'Unknown'}</h2>
            <p>{snapshot.me.roleDescription}</p>
            {snapshot.me.role === 'mafia' && (
              <div className="mafia-team"><small>YOUR INNER CIRCLE</small><div className="mafia-member-list">{snapshot.me.mafiaTeam.map((member) => <div className={`mafia-member ${member.alive ? '' : 'member-fallen'}`} key={member.id}><span>{avatarFor(member.avatar).face}</span><strong>{member.name}{member.id === snapshot.me.id ? ' · YOU' : ''}</strong><small>{member.alive ? 'ALIVE' : 'FALLEN'}</small></div>)}</div>
                <div className="mafia-coordination">
                  {snapshot.mafiaChoices?.map((choice) => (
                    <div key={choice.id}><span>{choice.name}</span><strong>{choice.targetName ? `→ ${choice.targetName}` : 'CHOOSING'}</strong></div>
                  ))}
                  <p>{snapshot.actionProgress?.mafiaTargetState === 'conflict' ? 'CONFLICTING TARGETS · FINAL WINDOW MAY OPEN' : snapshot.actionProgress?.mafiaTargetState === 'single' ? 'A TARGET HAS BEEN SUBMITTED' : 'WAITING FOR A TARGET'}</p>
                </div>
              </div>
            )}
            {snapshot.me.privateResults?.length > 0 && (
              <div className="private-results"><small>PRIVATE INVESTIGATION</small>{snapshot.me.privateResults.map((result) => <div key={result.id} className={`private-result result-${result.kind}`}>{result.text}</div>)}</div>
            )}
            </section>}
          </div>

          {(isRoleAction || isVotePhase) && (
            <section className="panel action-panel">
              <div className="panel-kicker">{isNight ? 'PRIVATE NIGHT ACTION' : 'CAST YOUR VOTE'}</div>
              <h3>{isNight ? 'Choose one living player' : isTie ? 'Choose between the accused' : 'Who should leave the table?'}</h3>
              {isTie && <p className="action-subtext">Choose only between the names still accused.</p>}
              {isNight && snapshot.me.role === 'mafia' && <p className="action-subtext">Choose a target. If only one target is submitted, that player is selected; conflicting targets earn one 15-second extension. You may revise your choice until the night ends.</p>}
              {isNight && snapshot.me.role === 'angel' && <p className="action-subtext">Choose who to protect. You may change your protection until the night ends.</p>}
              {isNight && snapshot.me.role === 'sheriff' && <p className="action-subtext">Your first investigation is final. The result will appear privately in a full-screen reveal at dawn.</p>}
              {targetPlayers.length > 0 ? (
                <div className="target-list">
                  {targetPlayers.map((player) => (
                    <button key={player.id} className={`target-option ${selectedTarget === player.id ? 'chosen' : ''}`} onClick={() => setSelectedTarget(player.id)}>
                      <span className="target-avatar">{avatarFor(player.avatar).face}</span><span>{player.name}</span><i>{selectedTarget === player.id ? '✦' : '○'}</i>
                    </button>
                  ))}
                </div>
              ) : <p className="empty-targets">No valid targets are available.</p>}
              <button className="primary-button full-button" onClick={isNight ? actNight : vote} disabled={!selectedTarget || (isNight && snapshot.me.role === 'sheriff' && snapshot.me.myActionSubmitted)}>{isNight && snapshot.me.role === 'sheriff' && snapshot.me.myActionSubmitted ? 'INVESTIGATION LOCKED' : snapshot.me.myActionSubmitted ? 'UPDATE ACTION' : isNight ? 'CONFIRM ACTION' : 'SUBMIT / CHANGE VOTE'}</button>

            </section>
          )}

          {isNight && !isRoleAction && <div className="panel waiting-panel"><div className="waiting-orbit">☾</div><h3>The town is asleep</h3><p>Wait for the morning bell. The night actions are hidden from you.</p></div>}

          {snapshot.me.isHost && (
            <section className="panel host-panel">
              <div className="panel-header"><div><div className="panel-kicker">HOST AUTHORITY</div><h2>Manage the table</h2></div><span className="panel-symbol">♜</span></div>
              <p className="host-panel-note">Remove a guest who is disrupting the game or cannot return. Their role stays secret until the final reveal.</p>
              <div className="host-player-list">
                {snapshot.players.filter((player) => player.id !== snapshot.me.id).map((player) => (
                  <div className="host-player-row" key={player.id}>
                    <span className="host-player-avatar">{avatarFor(player.avatar).face}</span>
                    <span className="host-player-name">{player.name}<small>{!player.connected ? 'OFFLINE' : !player.alive ? 'FALLEN' : 'IN GAME'}</small></span>
                    <button className="host-kick-button" onClick={() => onKickPlayer(player)}>REMOVE</button>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="panel chat-panel">
            <div className="panel-header"><div><div className="panel-kicker">LIVE CONVERSATION</div><h2>{chatTitle}</h2></div><span className="panel-symbol">☷</span></div>
            <div className={isNight && !identityVisible ? 'voice-concealed' : ''}>
              <VoiceRoom code={snapshot.code} token={session?.token} phase={snapshot.phase} round={snapshot.round} enabled={voiceEnabled} />
            </div>
            <div className="chat-log">
              {snapshot.chat.length === 0 && <div className="chat-empty">The walls are listening. Be the first to speak.</div>}
              {snapshot.chat.map((message) => (
                <div className={`chat-message ${message.playerId === snapshot.me.id ? 'chat-own' : ''}`} key={message.id}>
                  <span className="chat-avatar">{avatarFor(message.avatar).face}</span>
                  <div><small>{message.playerName} <time>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></small><p>{message.text}</p></div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <form className="chat-form" onSubmit={sendChat}>
              <input value={messageText} onChange={(event) => setMessageText(event.target.value.slice(0, 350))} placeholder={snapshot.me.alive ? 'Whisper to the table…' : 'The dead cannot speak…'} disabled={!snapshot.me.alive || !(isDiscussion || isVoting || isTie || (isNight && snapshot.me.role === 'mafia'))} />
              <button type="submit" disabled={!messageText.trim() || !snapshot.me.alive}>↗</button>
            </form>
          </section>
        </aside>
      </div>

    </section>
  );
}

function EndGame({ snapshot, onLeave }) {
  return (
    <>
      <section className="endgame-layout">
      <div className="eyebrow"><span /> THE FINAL VERDICT <span /></div>
      <div className={`endgame-seal ${snapshot.winner === 'mafia' ? 'seal-mafia' : 'seal-town'}`}>{snapshot.winner === 'mafia' ? '☠' : '✧'}</div>
      <div className={`winner-banner ${snapshot.winner === 'mafia' ? 'winner-mafia' : 'winner-town'}`}><span>THE WINNING FACTION</span><strong>{snapshot.winner === 'mafia' ? 'THE MAFIA' : 'THE TOWN'}</strong></div>
      <h1>{snapshot.winner === 'mafia' ? 'The house belongs to the Mafia.' : 'The town survives the night.'}</h1>
      <p>{snapshot.announcement?.text}</p>
      {snapshot.lastDeathAnnouncement && (
        <div className={`announcement announcement-${snapshot.lastDeathAnnouncement.accent || 'red'} final-death-report`}>
          <div className="announcement-side">✦</div>
          <div><div className="announcement-kicker">FINAL REPORT · {snapshot.lastDeathAnnouncement.kind === 'murder' ? 'MURDER' : snapshot.lastDeathAnnouncement.kind === 'departure' ? 'DEPARTURE' : 'ELIMINATION'}</div><h2>{snapshot.lastDeathAnnouncement.title}</h2><p>{snapshot.lastDeathAnnouncement.text}</p></div>
          <div className="announcement-side">✦</div>
        </div>
      )}
      <section className="panel reveal-panel">
        <div className="panel-kicker">EVERY SECRET, REVEALED</div>
        <h2>The final guest list</h2>
        <div className="reveal-grid">
          {snapshot.players.map((player) => (
            <div className={`reveal-player ${player.role === 'mafia' ? 'reveal-mafia' : ''}`} key={player.id}>
              <span className="reveal-avatar">{avatarFor(player.avatar).face}</span>
              <span className="reveal-name">{player.name}</span>
              <span className="reveal-role">{ROLE_NAMES[player.role] || player.role}</span>
              <span className={`reveal-state ${player.alive ? 'still-alive' : ''}`}>{player.alive ? 'SURVIVED' : 'CLAIMED'}</span>
            </div>
          ))}
        </div>
      </section>
      <button className="primary-button end-button" onClick={onLeave}>RETURN TO THE ENTRANCE <span>↗</span></button>
      </section>
    </>
  );
}

export default App;
