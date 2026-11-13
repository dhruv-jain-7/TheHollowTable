import { useEffect, useState } from 'react';
import { ControlBar, LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react';

export default function VoiceRoom({ code, token, phase, round, enabled }) {
  const [connection, setConnection] = useState(null);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setConnection(null);
    setMessage('');
    setStatus('loading');
    if (!enabled || !token) {
      setStatus('disabled');
      return () => { cancelled = true; };
    }
    fetch('/api/voice-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-player-token': token },
      body: JSON.stringify({ code, phase, round }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Voice chat is unavailable.');
        return data;
      })
      .then((data) => {
        if (!cancelled) {
          setConnection(data);
          setStatus('ready');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setMessage(err.message);
          setStatus('unavailable');
        }
      });
    return () => { cancelled = true; };
  }, [code, token, phase, round, enabled]);

  if (!enabled) return <div className="voice-note">Voice is muted outside the living players' discussion.</div>;
  if (status === 'loading') return <div className="voice-note">Opening the séance line…</div>;
  if (status === 'unavailable') return <div className="voice-note">{message} Use the table chat instead.</div>;
  if (!connection) return <div className="voice-note">Voice chat is not configured on this server. Table chat is ready.</div>;

  return (
    <div className="voice-room">
      <div className="voice-ready"><span className="live-dot" /> VOICE LINE OPEN · MIC MUTED BY DEFAULT</div>
      <LiveKitRoom
        serverUrl={connection.serverUrl}
        token={connection.token}
        connect
        audio={false}
        video={false}
        options={{ adaptiveStream: true, dynacast: true }}
        onDisconnected={() => setStatus('unavailable')}
      >
        <RoomAudioRenderer />
        <ControlBar controls={{ microphone: true, camera: false, screenShare: false, chat: false }} />
      </LiveKitRoom>
    </div>
  );
}
