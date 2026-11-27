import { useEffect } from 'react';

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
    body: 'Talk through what happened, then mark yourself ready or wait for the discussion clock. Cast a private vote. If the first vote ties, only the accused enter one final tie-break; a second tie eliminates nobody.',
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
  const steps = TUTORIAL_STEPS;
  const [step, setStep] = useTutorialStep(steps.length);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') setStep((current) => Math.min(steps.length - 1, current + 1));
      if (event.key === 'ArrowLeft') setStep((current) => Math.max(0, current - 1));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, steps.length]);

  const current = steps[step];
  return (
    <div className="experience-tutorial-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="experience-tutorial panel" role="dialog" aria-modal="true" aria-labelledby="experience-tutorial-title">
        <button type="button" className="rules-modal-close" onClick={onClose} aria-label="Close tutorial">×</button>
        <div className="eyebrow"><span /> THE HOUSE RULES <span /></div>
        <div className="tutorial-mode">{gameMode === 'in_person' ? 'GATHER AT THE TABLE' : 'SUMMON FROM AFAR'}</div>
        <div className="tutorial-progress" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((item, index) => <span key={item.label} className={index <= step ? 'active' : ''} />)}
        </div>
        <small className="tutorial-step-label">{current.label}</small>
        <h2 id="experience-tutorial-title">{current.title}</h2>
        <p className="tutorial-body">{current.body}</p>
        <div className="tutorial-note"><span>✦</span>{current.note}</div>
        <div className="tutorial-actions">
          <button type="button" className="outline-button" onClick={() => setStep((value) => Math.max(0, value - 1))} disabled={step === 0}>BACK</button>
          <button type="button" className="primary-button" onClick={() => step === steps.length - 1 ? onClose() : setStep((value) => Math.min(steps.length - 1, value + 1))}>{step === steps.length - 1 ? 'ENTER THE HOUSE' : 'CONTINUE'} <span>↗</span></button>
        </div>
        <button type="button" className="tutorial-skip" onClick={onClose}>SKIP TUTORIAL</button>
      </section>
    </div>
  );
}

function useTutorialStep(length) {
  const [step, setStep] = ReactUseState(0);
  useEffect(() => { setStep((current) => Math.min(current, length - 1)); }, [length]);
  return [step, setStep];
}

import { useState as ReactUseState } from 'react';
