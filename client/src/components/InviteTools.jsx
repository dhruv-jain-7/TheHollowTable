import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';

export default function InviteTools({ code, gameMode }) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [status, setStatus] = useState('');
  const inviteUrl = useMemo(() => {
    const url = new URL('/', window.location.origin);
    url.searchParams.set('code', code);
    url.searchParams.set('mode', gameMode === 'in_person' ? 'in_person' : 'online');
    return url.toString();
  }, [code, gameMode]);

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(inviteUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 260,
      color: { dark: '#ead8b7', light: '#100d0c' },
    }).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl);
    }).catch(() => {
      if (active) setStatus('QR PREVIEW UNAVAILABLE · SHARE THE LINK INSTEAD');
    });
    return () => { active = false; };
  }, [inviteUrl]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setStatus('INVITE LINK COPIED');
    } catch {
      setStatus('COPY IS UNAVAILABLE · SHARE THE TABLE CODE');
    }
  };

  const shareLink = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Join my Hollow Table',
          text: `Join my ${gameMode === 'in_person' ? 'In-Person' : 'Online'} Hollow Table. Table code: ${code}`,
          url: inviteUrl,
        });
        setStatus('INVITE READY TO SHARE');
      } catch (error) {
        if (error?.name !== 'AbortError') setStatus('SHARING WAS NOT AVAILABLE · COPY THE LINK INSTEAD');
      }
      return;
    }
    await copyLink();
  };

  return (
    <div className="invite-tools">
      <div className="invite-qr-frame">
        {qrDataUrl ? <img src={qrDataUrl} alt={`QR code to join table ${code}`} /> : <span>PREPARING QR</span>}
      </div>
      <div className="invite-tools-copy">
        <strong>LET THEM SCAN THEIR WAY IN</strong>
        <span>Scan with a phone camera to open the join screen with this code and game mode filled in.</span>
        <div className="invite-tools-actions">
          <button type="button" className="outline-button" onClick={shareLink}>SHARE INVITE</button>
          <button type="button" className="outline-button" onClick={copyLink}>COPY LINK</button>
        </div>
        <small className="invite-tools-status" role="status" aria-live="polite">{status || 'THE QR CODE CONTAINS ONLY THE TABLE CODE AND MODE.'}</small>
      </div>
    </div>
  );
}
