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
  return 'THE GAME IS OVER';
}

function phaseDescription(snapshot) {
  if (snapshot.phase === 'night') {
    if (snapshot.me.role === 'mafia') return 'The town is asleep. Your team must agree on one victim.';
    if (snapshot.me.role === 'sheriff') return 'Choose one living player to investigate in secret.';
    if (snapshot.me.role === 'angel') return 'Choose one living soul to protect tonight.';
    return 'The house is silent. Wait for dawn.';
  }
  if (snapshot.phase === 'discussion') return 'Talk at the table. Compare stories. Find the person hiding in plain sight.';
  if (snapshot.phase === 'voting') return 'Choose one living player to eliminate. Votes are private until the verdict.';
  if (snapshot.phase === 'tieVoting') return 'The vote was tied. You have five minutes to reconsider between the accused.';
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
    socket.on('connect', onConnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off('room:state', onState);
      socket.off('session:replaced', onReplaced);
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
    else flash('Your vote has been recorded. You may change it before the timer ends.');
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

function Lobby({ snapshot, maxPlayers, mafiaCount, onUpdate, onStart, busy, onCopy }) {
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
                <span className={`guest-status ${player.connected ? 'connected' : ''}`}><i /> {player.connected ? 'HERE' : 'AWAY'}</span>
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

function Game({ snapshot, countdown, selectedTarget, setSelectedTarget, actNight, vote, messageText, setMessageText, sendChat, chatEndRef, session }) {
  const isNight = snapshot.phase === 'night';
  const isDiscussion = snapshot.phase === 'discussion';
  const isVoting = snapshot.phase === 'voting';
  const isTie = snapshot.phase === 'tieVoting';
  const isRoleAction = isNight && ['mafia', 'sheriff', 'angel'].includes(snapshot.me.role);
  const isVotePhase = isVoting || isTie;
  const phaseTimer = countdown == null ? '—' : formatTime(countdown);
  const alivePlayers = snapshot.players.filter((player) => player.alive);
  const targetPlayers = alivePlayers.filter((player) => (player.id !== snapshot.me.id || (isNight && snapshot.me.role === 'angel')) && (!isTie || snapshot.tieCandidates.some((candidate) => candidate.id === player.id)));
  const voiceEnabled = snapshot.me.alive && (isDiscussion || isTie || (isNight && snapshot.me.role === 'mafia'));
  const timerUrgent = countdown != null && countdown < 60_000;
  const chatTitle = isNight && snapshot.me.role === 'mafia' ? 'THE INNER CIRCLE' : 'THE TABLE WHISPERS';

  const ringPlayers = useMemo(() => snapshot.players.map((player, index) => {
    const angle = (Math.PI * 2 * index) / snapshot.players.length - Math.PI / 2;
    return { ...player, x: 50 + Math.cos(angle) * 39, y: 50 + Math.sin(angle) * 40 };
  }), [snapshot.players]);

  return (
    <section className="game-layout">
      <div className="game-topline">
        <div><span className="room-pill">TABLE {snapshot.code}</span><span className="round-pill">ROUND {snapshot.round}</span></div>
        <div className={`phase-clock ${timerUrgent ? 'urgent' : ''}`}><small>{snapshot.phase === 'night' ? 'NIGHT ENDS IN' : snapshot.phase === 'discussion' ? 'DISCUSSION ENDS IN' : snapshot.phase === 'tieVoting' ? 'RECONSIDERATION ENDS IN' : snapshot.phase === 'voting' ? 'VOTING ENDS IN' : 'TIME'}</small><strong>{phaseTimer}</strong></div>
      </div>
      <div className="game-heading"><div className="eyebrow"><span /> {snapshot.phase === 'night' ? 'THE HOUSE HOLDS ITS BREATH' : 'THE LIVING HAVE THE FLOOR'} <span /></div><h1>{phaseTitle(snapshot)}</h1><p>{phaseDescription(snapshot)}</p></div>

      {snapshot.announcement && (
        <div key={snapshot.announcement.id} className={`announcement announcement-${snapshot.announcement.accent || 'red'}`}>
          <div className="announcement-side">✦</div>
          <div><div className="announcement-kicker">{snapshot.announcement.kind === 'murder' ? 'MURDER REPORT' : snapshot.announcement.kind === 'elimination' ? 'ELIMINATION REPORT' : snapshot.announcement.kind === 'departure' ? 'DEPARTURE REPORT' : 'A MESSAGE FROM THE HOUSE'}</div><h2>{snapshot.announcement.title}</h2><p className="typewriter-text">{snapshot.announcement.text}</p></div>
          <div className="announcement-side">✦</div>
        </div>
      )}

      <div className="game-main-grid">
        <section className={`table-stage ${isNight ? 'table-night' : ''}`}>
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
                title={`${player.name}${player.alive ? '' : ` · ${ROLE_NAMES[player.role] || player.role}`}`}
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
          <section className="panel role-panel">
            <div className="panel-kicker">YOUR SECRET IDENTITY</div>
            <div className={`role-medallion role-${snapshot.me.role || 'citizen'}`}>{ROLE_SIGNS[snapshot.me.role] || '♟'}</div>
            <h2>{ROLE_NAMES[snapshot.me.role] || 'Unknown'}</h2>
            <p>{snapshot.me.roleDescription}</p>
            {snapshot.me.role === 'mafia' && (
              <div className="mafia-team"><small>YOUR INNER CIRCLE</small>{snapshot.me.mafiaTeam.map((member) => <span key={member.id}>{member.name}{member.id === snapshot.me.id ? ' (YOU)' : ''}{!member.alive ? ' · DEAD' : ''}</span>)}</div>
            )}
            {snapshot.me.privateResults?.length > 0 && (
              <div className="private-results"><small>PRIVATE INVESTIGATION</small>{snapshot.me.privateResults.map((result) => <div key={result.id} className={`private-result result-${result.kind}`}>{result.text}</div>)}</div>
            )}
          </section>

          {(isRoleAction || isVotePhase) && (
            <section className="panel action-panel">
              <div className="panel-kicker">{isNight ? 'CHOOSE YOUR ACTION' : 'CAST YOUR VOTE'}</div>
              <h3>{isNight ? snapshot.me.role === 'mafia' ? 'Choose a murder target' : snapshot.me.role === 'sheriff' ? 'Choose someone to investigate' : 'Choose someone to protect' : isTie ? 'Choose between the accused' : 'Who should be eliminated?'}</h3>
              {isTie && <p className="action-subtext">Only the tied candidates may receive a vote.</p>}
              {targetPlayers.length > 0 ? (
                <div className="target-list">
                  {targetPlayers.map((player) => (
                    <button key={player.id} className={`target-option ${selectedTarget === player.id ? 'chosen' : ''}`} onClick={() => setSelectedTarget(player.id)}>
                      <span className="target-avatar">{avatarFor(player.avatar).face}</span><span>{player.name}</span><i>{selectedTarget === player.id ? '✦' : '○'}</i>
                    </button>
                  ))}
                </div>
              ) : <p className="empty-targets">No valid targets are available.</p>}
              <button className="primary-button full-button" onClick={isNight ? actNight : vote} disabled={!selectedTarget}>{snapshot.me.myActionSubmitted ? 'UPDATE ACTION' : isNight ? 'CONFIRM ACTION' : 'SUBMIT / CHANGE VOTE'}</button>
              {isNight && snapshot.me.role === 'mafia' && <small className="tiny-note">Friendly fire is possible. You may target another Mafia member.</small>}
              {!isNight && <small className="tiny-note">Votes are private. You can change your choice until the clock ends.</small>}
            </section>
          )}

          {isNight && !isRoleAction && <div className="panel waiting-panel"><div className="waiting-orbit">☾</div><h3>The town is asleep</h3><p>Wait for the morning bell. The night actions are hidden from you.</p></div>}

          <section className="panel chat-panel">
            <div className="panel-header"><div><div className="panel-kicker">LIVE CONVERSATION</div><h2>{chatTitle}</h2></div><span className="panel-symbol">☷</span></div>
            <VoiceRoom code={snapshot.code} token={session?.token} phase={snapshot.phase} round={snapshot.round} enabled={voiceEnabled} />
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
      <div className="game-bottom-bar"><span><i /> SERVER-SYNCED GAME CLOCK</span><span>{snapshot.actionProgress.required > 0 ? `${snapshot.actionProgress.submitted}/${snapshot.actionProgress.required} ${isNight ? 'MAFIA CHOICES' : 'VOTES'} RECORDED` : 'PRIVATE ACTIONS'}</span><span>ROLES HIDDEN UNTIL DEATH</span></div>
    </section>
  );
}

function EndGame({ snapshot, onLeave }) {
  return (
    <section className="endgame-layout">
      <div className="eyebrow"><span /> THE FINAL VERDICT <span /></div>
      <div className={`endgame-seal ${snapshot.winner === 'mafia' ? 'seal-mafia' : 'seal-town'}`}>{snapshot.winner === 'mafia' ? '☠' : '✧'}</div>
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
  );
}

export default App;
