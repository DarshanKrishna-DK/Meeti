'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { instrumentGeometry } from './artwork/instrument-geometry';
import { instrumentPalette } from './artwork/instrument-palette';
import { createInspectionLamp, type InspectionLamp } from './artwork/inspection-lamp';
import styles from './artwork/connection-instrument.module.css';

const stages = [
  { label: 'Discover', title: 'Start with a little intention.',
    description: 'Only the public intent you approve is discoverable. Your private profile stays with you.' },
  { label: 'Permissions', title: 'A narrow permission, not an open door.',
    description: 'Current ENS permissions limit what an agent can do and share. The inspection shutter illustrates that boundary.' },
  { label: 'Both decide', title: 'One decision belongs to each person.',
    description: 'Both people review a proposed introduction. One person can never supply the other person\'s consent.' },
  { label: 'Release locked', title: 'The last gate stays closed.',
    description: 'World verification is paused. Protected rooms stay locked, even after both people approve.' },
] as const;

const settledWithin = .001;
function approach(current: number, target: number, amount: number) {
  return Math.abs(current - target) < settledWithin ? target : current + (target - current) * amount;
}

export function ConnectionInstrument({ className = '' }: { className?: string }) {
  const [selected, setSelected] = useState(0);
  const root = useRef<HTMLElement>(null);
  const stageRoot = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const target = useRef(0);
  const kick = useRef<() => void>(() => undefined);
  const descriptionId = useId();

  useEffect(() => {
    const stage = stageRoot.current, surface = canvas.current;
    if (!stage || !surface) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const carriage = [...stage.querySelectorAll<SVGGElement>('[data-part-group="carriage"]')];
    const shutter = [...stage.querySelectorAll<SVGGElement>('[data-part-group="shutter"]')];
    const D = instrumentGeometry.dimensions;
    let lamp: InspectionLamp | null = createInspectionLamp(surface);
    stage.dataset.webgl = lamp ? 'active' : 'fallback';
    let frame = 0, previous = 0, visible = false, stopped = false;
    let position = 0, opening = 0, intensity = 0;

    const paint = () => {
      const carriageTransform = `translate(${D.carriageVector[0] * position} ${D.carriageVector[1] * position})`;
      const shutterTransform = `translate(${D.shutterVector[0] * opening} ${D.shutterVector[1] * opening})`;
      for (const item of carriage) item.setAttribute('transform', carriageTransform);
      for (const item of shutter) item.setAttribute('transform', shutterTransform);
      lamp?.draw(position * 14, intensity);
    };
    const tick = (now: number) => {
      frame = 0;
      if (stopped || !visible || document.hidden) return;
      const elapsed = previous ? Math.min((now - previous) / 1000, 1 / 30) : 1 / 60;
      previous = now;
      const amount = reduced.matches ? 1 : 1 - Math.exp(-elapsed / .18);
      const desiredPosition = target.current > 0 ? 1 : 0;
      const desiredOpening = target.current > 0 ? 1 : 0;
      const desiredIntensity = [.25, .52, .38, .12][target.current];
      position = approach(position, desiredPosition, amount);
      opening = approach(opening, desiredOpening, amount);
      intensity = approach(intensity, desiredIntensity, amount);
      paint();
      const moving = position !== desiredPosition || opening !== desiredOpening || intensity !== desiredIntensity;
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
    <figure ref={root} className={`${styles.figure} ${className}`} aria-label="How a permissioned introduction works" data-explanation-stage={selected}>
      <style>{instrumentPalette}</style>
      <div className={styles.heading}><span>Interactive explanation</span><span className={styles.locked}><LockMark />Release locked</span></div>
      <div ref={stageRoot} className={styles.stage} data-webgl="fallback" aria-describedby={descriptionId}>
        <svg className="mi-drawing" viewBox="0 0 680 420" role="img" aria-label="Two intent-card trays, an inspection carriage, a narrow permission shutter, separate decision pins and a locked release door.">
          <ellipse cx="350" cy="318" rx="240" ry="55" fill="#0b080e" opacity=".3" />
          {instrumentGeometry.layers.back.map(item => <g key={item.name} data-part-group={item.group || undefined} dangerouslySetInnerHTML={{ __html: item.svg }} />)}
        </svg>
        <canvas ref={canvas} className={styles.lamp} aria-hidden="true" />
        <svg className={`mi-drawing ${styles.front}`} viewBox="0 0 680 420" aria-hidden="true">
          {instrumentGeometry.layers.front.map(item => <g key={item.name} data-part-group={item.group || undefined} dangerouslySetInnerHTML={{ __html: item.svg }} />)}
        </svg>
      </div>
      <div ref={controls} className={styles.controls} role="group" aria-label="Explore the introduction explanation" onKeyDown={onKeyDown}>
        {stages.map((stage, index) => <button key={stage.label} type="button" aria-pressed={selected === index} onClick={() => select(index)}>{stage.label}</button>)}
      </div>
      <figcaption className={styles.caption} id={descriptionId}>
        <div aria-live="polite" aria-atomic="true"><strong>{frame.title}</strong><p>{frame.description}</p></div>
        <span className={styles.disclaimer}>Illustration, not live activity.</span>
      </figcaption>
    </figure>
  );
}

function LockMark() {
  return <svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill="none"><rect x="4" y="8" width="12" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" /><path d="M6.5 8V5a3.5 3.5 0 017 0v3M10 11.5v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>;
}
