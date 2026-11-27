import { useEffect, useRef, useState } from 'react';

const TUTORIAL_STEPS = [
  {
    label: '01 · TAKE YOUR SEAT',
    title: 'One table. Many secrets.',
    body: 'Your role is private. Keep your identity card to yourself, and never share a screenshot of your private results. The full role reveal happens after the final verdict.',
    note: 'The host starts when at least five players have joined.',
  },
  {
    label: '02 · WHEN NIGHT FALLS',
    title: 'Act only when it is your turn.',
    body: 'Online: night actions happen privately during the shared night timer. In Person: keep your phone connected, follow the narrator’s fixed calls, and act only when your role is summoned.',
    note: 'In-Person gatherings need one narrator phone with its house voice enabled. This is not offline play.',
  },
  {
    label: '03 · WHEN DAY BREAKS',
    title: 'Discuss. Decide. Vote.',
    body: 'Talk through what happened, then mark yourself ready or wait for the discussion clock. Cast a private vote. If the first vote ties, the players vote again between the tied accused; a second tie eliminates nobody.',
    note: 'In-Person players speak across the physical table. Online players can use text chat and optional voice.',
  },
  {
    label: '04 · THE FINAL VERDICT',
    title: 'Find the hidden faction.',
    body: 'The town wins when every Mafia member is gone. The Mafia win when their living number equals or exceeds everyone else. An optional Undertaker may inherit one eligible fallen role from Round 2 onward.',
    note: 'The dead cannot vote or act. Keep playing until the house announces a winner.',
  },
];

export default function ExperienceTutorial({ gameMode, onClose }) {
  const [step, setStep] = useState(0);
  const dialogRef = useRef(null);
  const current = TUTORIAL_STEPS[step];

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const dialog = dialogRef.current;
    const getFocusable = () => [...(dialog?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), [tabindex]') || [])];
    getFocusable()[0]?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { onClose(); return; }
      if (event.key === 'ArrowRight') setStep((value) => Math.min(TUTORIAL_STEPS.length - 1, value + 1));
      if (event.key === 'ArrowLeft') setStep((value) => Math.max(0, value - 1));
      if (event.key !== 'Tab') return;
      const items = getFocusable();
      if (!items.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0].focus(); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  return (
    <div className="experience-tutorial-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="experience-tutorial panel" role="dialog" aria-modal="true" aria-labelledby="experience-tutorial-title">
        <button type="button" className="rules-modal-close" onClick={onClose} aria-label="Close tutorial">×</button>
        <div className="eyebrow"><span /> THE HOUSE RULES <span /></div>
        <div className="tutorial-mode">{gameMode === 'in_person' ? 'GATHER AT THE TABLE' : 'SUMMON FROM AFAR'}</div>
        <div className="tutorial-progress" aria-label={`Step ${step + 1} of ${TUTORIAL_STEPS.length}`}>
          {TUTORIAL_STEPS.map((item, index) => <span key={item.label} className={index <= step ? 'active' : ''} />)}
        </div>
        <small className="tutorial-step-label">{current.label}</small>
        <h2 id="experience-tutorial-title">{current.title}</h2>
        <p className="tutorial-body">{current.body}</p>
        <div className="tutorial-note"><span>✦</span>{current.note}</div>
        <div className="tutorial-actions">
          <button type="button" className="outline-button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>BACK</button>
          <button type="button" className="primary-button" onClick={() => step === TUTORIAL_STEPS.length - 1 ? onClose() : setStep((value) => Math.min(TUTORIAL_STEPS.length - 1, value + 1))}>{step === TUTORIAL_STEPS.length - 1 ? 'ENTER THE HOUSE' : 'CONTINUE'} <span>↗</span></button>
        </div>
        <button type="button" className="tutorial-skip" onClick={onClose}>SKIP TUTORIAL</button>
      </section>
    </div>
  );
}
