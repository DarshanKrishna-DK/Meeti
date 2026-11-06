'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { LockKeyhole } from 'lucide-react';
import { instrumentGeometry } from './artwork/instrument-geometry';
import { instrumentPalette } from './artwork/instrument-palette';
import { createInspectionLamp, type InspectionLamp } from './artwork/inspection-lamp';
import styles from './artwork/connection-instrument.module.css';

const stages = [
  { label: 'Share an intent', title: 'Start with what you want to do.', status: 'Only approved public intent',
    description: 'Share an intent for a collaboration, conversation, or opportunity. You decide what becomes public.' },
  { label: 'Set boundaries', title: 'Your agent works within your permission.', status: 'A narrow, revocable permission',
    description: 'Set narrow, revocable ENS permissions. Your agent can only share or update what those permissions allow.' },
  { label: 'Both decide', title: 'Two people. Two separate decisions.', status: 'Each person has their own say',
    description: 'Review the proposed introduction separately. It can continue only when both people consent.' },
  { label: 'Protected intro', title: 'The final door stays locked.', status: 'Locked: World verification paused',
    description: 'Even with both consents, protected introductions need fresh World validation. World is paused, so this door stays closed.' },
] as const;

const settledWithin = .001;
function approach(current: number, target: number, amount: number) {
  return Math.abs(current - target) < settledWithin ? target : current + (target - current) * amount;
}

export function ConnectionInstrument({ className = '' }: { className?: string }) {
  const [selected, setSelected] = useState(0);
  const stageRoot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const target = useRef(0);
  const kick = useRef<() => void>(() => undefined);
  const descriptionId = useId();
  const panelId = useId();
  const controlPrefix = useId();

  useEffect(() => {
    const stage = stageRoot.current, surface = canvas.current;
    if (!stage || !surface) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const carriage = [...stage.querySelectorAll<SVGGElement>('[data-part-group="carriage"]')];
    const shutter = [...stage.querySelectorAll<SVGGElement>('[data-part-group="shutter"]')];
    const decisionA = [...stage.querySelectorAll<SVGGElement>('[data-part-group="decision-67"]')];
    const decisionB = [...stage.querySelectorAll<SVGGElement>('[data-part-group="decision-88"]')];
    const D = instrumentGeometry.dimensions;
    let lamp: InspectionLamp | null = createInspectionLamp(surface);
    stage.dataset.webgl = lamp ? 'active' : 'fallback';
    let frame = 0, previous = 0, visible = false, stopped = false;
    let position = 0, opening = 0, intensity = 0, choiceA = 0, choiceB = 0;

    const paint = () => {
      const carriageTransform = `translate(${D.carriageVector[0] * position} ${D.carriageVector[1] * position})`;
      const shutterTransform = `translate(${D.shutterVector[0] * opening} ${D.shutterVector[1] * opening})`;
      for (const item of carriage) item.setAttribute('transform', carriageTransform);
      for (const item of shutter) item.setAttribute('transform', shutterTransform);
      for (const item of decisionA) item.setAttribute('transform', `translate(0 ${choiceA * 4.2})`);
      for (const item of decisionB) item.setAttribute('transform', `translate(0 ${choiceB * 4.2})`);
      lamp?.draw(position * 14, intensity);
    };
    const tick = (now: number) => {
      frame = 0;
      if (stopped || !visible || document.hidden) return;
      const elapsed = previous ? Math.min((now - previous) / 1000, 1 / 30) : 1 / 60;
      previous = now;
      const amount = reduced.matches ? 1 : 1 - Math.exp(-elapsed / .18);
      const desiredPosition = [0, .65, 1, .82][target.current];
      const desiredOpening = [0, 1, .65, 0][target.current];
      const desiredIntensity = [.16, .42, .24, .08][target.current];
      const desiredChoice = target.current >= 2 ? 1 : 0;
      position = approach(position, desiredPosition, amount);
      opening = approach(opening, desiredOpening, amount);
      intensity = approach(intensity, desiredIntensity, amount);
      choiceA = approach(choiceA, desiredChoice, amount);
      choiceB = approach(choiceB, desiredChoice, reduced.matches ? 1 : amount * .68);
      paint();
      const moving = position !== desiredPosition || opening !== desiredOpening || intensity !== desiredIntensity || choiceA !== desiredChoice || choiceB !== desiredChoice;
      if (!reduced.matches && moving) frame = requestAnimationFrame(tick);
    };
    const run = () => {
      if (!frame && !stopped && visible && !document.hidden) {
        previous = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    kick.current = run;
    const intersection = new IntersectionObserver(entries => {
      visible = entries[entries.length - 1]?.isIntersecting || false;
      if (visible) run();
      else { cancelAnimationFrame(frame); frame = 0; }
    }, { rootMargin: '60px 0px' });
    intersection.observe(stage);
    const resize = new ResizeObserver(run);
    resize.observe(stage);
    const onVisibility = () => {
      if (document.hidden) { cancelAnimationFrame(frame); frame = 0; }
      else run();
    };
    const onLost = (event: Event) => {
      event.preventDefault();
      lamp?.dispose();
      lamp = null;
      stage.dataset.webgl = 'fallback';
    };
    const onRestored = () => {
      lamp = createInspectionLamp(surface);
      stage.dataset.webgl = lamp ? 'active' : 'fallback';
      run();
    };
    surface.addEventListener('webglcontextlost', onLost);
    surface.addEventListener('webglcontextrestored', onRestored);
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', run);
    stage.dataset.artworkReady = 'true';
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      intersection.disconnect();
      resize.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', run);
      surface.removeEventListener('webglcontextlost', onLost);
      surface.removeEventListener('webglcontextrestored', onRestored);
      lamp?.dispose();
      kick.current = () => undefined;
    };
  }, []);

  const select = (index: number) => {
    const next = Math.max(0, Math.min(stages.length - 1, index));
    target.current = next;
    setSelected(next);
    kick.current();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? stages.length - 1 : Math.max(0, Math.min(stages.length - 1, selected + step));
    select(index);
    controls.current?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus();
  };
  const frame = stages[selected];
  return (
    <figure className={`${styles.figure} ${className}`} aria-label="How a permissioned introduction works" data-explanation-stage={selected}>
      <style>{instrumentPalette}</style>
      <div className={styles.heading}><span>The introduction instrument</span><span className={styles.locked}><LockKeyhole size={14} aria-hidden="true" />Release locked</span></div>
      <div className={styles.readout}><span>0{selected + 1} / 04</span><strong>{frame.status}</strong></div>
      <div ref={stageRoot} className={styles.stage} data-webgl="fallback" aria-describedby={descriptionId}>
        <svg className="mi-drawing" viewBox="0 0 680 420" role="img" aria-label={`Illustration, step ${selected + 1}: ${frame.status}. Two intent-card trays lead through a permission shutter and separate decision switches to a door that remains locked.`}>
          <ellipse cx="350" cy="318" rx="240" ry="55" fill="#713c58" opacity=".07" />
          {instrumentGeometry.layers.back.map(item => <g key={item.name} data-part-group={item.group || undefined} dangerouslySetInnerHTML={{ __html: item.svg }} />)}
        </svg>
        <canvas ref={canvas} className={styles.lamp} aria-hidden="true" />
        <svg className={`mi-drawing ${styles.front}`} viewBox="0 0 680 420" aria-hidden="true">
          {instrumentGeometry.layers.front.map(item => <g key={item.name} data-part-group={item.group || undefined} dangerouslySetInnerHTML={{ __html: item.svg }} />)}
          <g className={styles.callout}>
            {selected === 0 && <><path d="M181 154V128H103" /><circle cx="181" cy="154" r="5" /><text x="103" y="115">Your public intent</text><path d="M257 122V85H164" /><circle cx="257" cy="122" r="5" /><text x="164" y="72">Their public intent</text></>}
            {selected === 1 && <><path d="M401 147V88H474" /><circle cx="401" cy="147" r="5" /><text x="430" y="74">Permission boundary</text><path className={styles.exchange} d="M328 226L391 201" /><text x="245" y="360">Only what you allow passes through.</text></>}
            {selected === 2 && <><path d="M364 259L337 319H267" /><path d="M387 273L415 341H481" /><circle cx="364" cy="259" r="6" /><circle cx="387" cy="273" r="6" /><text x="209" y="323">Your decision</text><text x="428" y="365">Their decision</text><text x="218" y="83">Neither person can decide for the other.</text></>}
            {selected === 3 && <><rect className={styles.doorFocus} x="454" y="183" width="77" height="93" rx="16" /><path d="M498 183V126H563" /><text x="442" y="111">World paused</text><text x="443" y="326">Door stays locked</text><path d="M489 276V306" /></>}
          </g>
        </svg>
      </div>
      <div ref={controls} className={styles.controls} role="tablist" aria-label="Explore four introduction steps" onKeyDown={onKeyDown}>
        {stages.map((stage, index) => <button key={stage.label} id={`${controlPrefix}-${index}`} type="button" role="tab" aria-selected={selected === index} aria-controls={panelId} tabIndex={selected === index ? 0 : -1} onClick={() => select(index)}><span className={styles.stepNumber}>0{index + 1}</span>{stage.label}</button>)}
      </div>
      <figcaption className={styles.caption} id={descriptionId}>
        <div id={panelId} role="tabpanel" aria-labelledby={`${controlPrefix}-${selected}`} tabIndex={0} aria-live="polite" aria-atomic="true"><strong>{frame.title}</strong><p>{frame.description}</p></div>
        <span className={styles.disclaimer}>Illustration, not live activity.</span>
      </figcaption>
    </figure>
  );
}
