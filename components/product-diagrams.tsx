import { Eye, Fingerprint, LockKeyhole, ShieldCheck, SlidersHorizontal, UserRound } from 'lucide-react';
import styles from './artwork/product-diagrams.module.css';

type DiagramKind = 'problem' | 'solution' | 'privacy' | 'setup';

const summaries: Record<DiagramKind, { title: string; description: string }> = {
  problem: { title: 'A profile does not explain why you want to connect.', description: 'Two profile cards have names and interests, but a gap remains between them: what are they hoping to do together?' },
  solution: { title: 'Start with what you want to do.', description: 'Two example intent notes meet around a specific purpose. A proposed introduction still belongs to both people to review.' },
  privacy: { title: 'Share an intent. Keep your private context private.', description: 'A closed private notebook stays behind a permission boundary. Only an explicitly approved public intent can appear in discovery.' },
  setup: { title: 'A name, an intent, and boundaries you control.', description: 'Setup begins with your ENS identity, your approved public intent, and your agent permissions. World verification is paused and the introduction gate remains locked.' },
};

export function ProductDiagram({ kind, className = '' }: { kind: DiagramKind; className?: string }) {
  const summary = summaries[kind];
  return <svg className={`${styles.diagram} ${className}`} viewBox="0 0 540 330" role="img" aria-label={`${summary.title} ${summary.description}`}>
    <title>{summary.title}</title>
    <desc>{summary.description}</desc>
    {kind === 'problem' && <Problem />}
    {kind === 'solution' && <Solution />}
    {kind === 'privacy' && <Privacy />}
    {kind === 'setup' && <Setup />}
  </svg>;
}

function Note({ x, y, tilt, heading, lines }: { x: number; y: number; tilt: number; heading: string; lines: string[] }) {
  return <g transform={`translate(${x} ${y}) rotate(${tilt} 78 82)`}>
    <rect className={styles.shadow} x="4" y="7" width="156" height="166" rx="14" />
    <rect className={styles.paper} width="156" height="166" rx="14" />
    <path className={styles.rule} d="M0 43H156" />
    <circle className={styles.pin} cx="78" cy="11" r="4" />
    <text className={styles.overline} x="16" y="29">{heading}</text>
    {lines.map((line, index) => <text key={line} className={styles.body} x="16" y={72 + index * 24}>{line}</text>)}
    <path className={styles.faintRule} d="M16 138H112M16 148H84" />
  </g>;
}

function Problem() {
  return <>
    <ellipse className={styles.ground} cx="270" cy="269" rx="205" ry="20" />
    <g transform="translate(55 64) rotate(-7 78 82)">
      <rect className={styles.shadow} x="4" y="7" width="158" height="169" rx="14" />
      <rect className={styles.paper} width="158" height="169" rx="14" />
      <circle className={styles.soft} cx="47" cy="47" r="23" />
      <UserRound x={33} y={32} width={28} height={28} className={styles.icon} aria-hidden="true" />
      <text className={styles.body} x="22" y="94">A name.</text><text className={styles.body} x="22" y="119">A few interests.</text>
      <path className={styles.faintRule} d="M22 142H128" />
    </g>
    <g transform="translate(326 64) rotate(7 78 82)">
      <rect className={styles.shadow} x="4" y="7" width="158" height="169" rx="14" />
      <rect className={styles.paper} width="158" height="169" rx="14" />
      <circle className={styles.soft} cx="47" cy="47" r="23" />
      <UserRound x={33} y={32} width={28} height={28} className={styles.icon} aria-hidden="true" />
      <text className={styles.body} x="22" y="94">Another name.</text><text className={styles.body} x="22" y="119">Similar interests.</text>
      <path className={styles.faintRule} d="M22 142H128" />
    </g>
    <path className={styles.dotted} d="M220 145H237M303 145H320" />
    <circle className={styles.question} cx="270" cy="145" r="32" />
    <text className={styles.questionMark} x="270" y="154" textAnchor="middle">?</text>
    <text className={styles.label} x="270" y="269" textAnchor="middle" dominantBaseline="central">But why connect?</text>
  </>;
}

function Solution() {
  return <>
    <ellipse className={styles.ground} cx="270" cy="288" rx="214" ry="38" />
    <Note x={54} y={55} tilt={-8} heading="AN EXAMPLE INTENT" lines={['Find someone', 'to build with.']} />
    <Note x={329} y={55} tilt={8} heading="AN EXAMPLE INTENT" lines={['Meet a curious', 'collaborator.']} />
    <path className={styles.connector} d="M212 143H237M303 143H328" />
    <circle className={styles.accentDisc} cx="270" cy="143" r="34" />
    <circle className={styles.discRing} cx="259" cy="143" r="13" /><circle className={styles.discRing} cx="281" cy="143" r="13" />
    <text className={styles.label} x="270" y="276" textAnchor="middle" dominantBaseline="central">A reason to begin.</text>
    <text className={styles.small} x="270" y="302" textAnchor="middle" dominantBaseline="central">Then, a decision for each person.</text>
  </>;
}

function Privacy() {
  return <>
    <ellipse className={styles.ground} cx="270" cy="308" rx="214" ry="18" />
    <g transform="translate(51 71) rotate(-6 80 80)">
      <path className={styles.bookEdge} d="M13 7H162V176H13Q1 176 1 164V19Q1 7 13 7Z" />
      <rect className={styles.book} width="155" height="170" rx="10" />
      <path className={styles.bookSeam} d="M18 0V170" />
      <LockKeyhole x={66} y={39} width={30} height={30} className={styles.lightIcon} aria-hidden="true" />
      <text className={styles.lightText} x="74" y="104" textAnchor="middle">Private context</text>
      <path className={styles.bookLines} d="M49 126H120M60 137H109" />
      <rect className={styles.bookBand} x="126" y="-1" width="10" height="172" rx="2" />
    </g>
    <path className={styles.boundary} d="M270 54V251" />
    <circle className={styles.boundarySeal} cx="270" cy="151" r="23" />
    <SlidersHorizontal x={258} y={139} width={24} height={24} className={styles.icon} aria-hidden="true" />
    <g transform="translate(331 72) rotate(6 78 82)">
      <rect className={styles.shadow} x="4" y="7" width="156" height="166" rx="14" />
      <rect className={styles.paper} width="156" height="166" rx="14" />
      <Eye x={61} y={29} width={32} height={32} className={styles.icon} aria-hidden="true" />
      <text className={styles.body} x="78" y="97" textAnchor="middle">Approved intent</text>
      <text className={styles.small} x="78" y="121" textAnchor="middle">Public discovery</text>
      <path className={styles.faintRule} d="M38 142H118" />
    </g>
    <text className={styles.label} x="270" y="308" textAnchor="middle" dominantBaseline="central">You choose what crosses the boundary.</text>
  </>;
}

function Setup() {
  return <>
    <path className={styles.dotted} d="M100 140H443" />
    {[{ x: 79, y: 110, label: 'Your name', detail: 'ENS identity', Icon: Fingerprint }, { x: 207, y: 110, label: 'Your intent', detail: 'Your words', Icon: Eye }, { x: 335, y: 110, label: 'Your rules', detail: 'ENS permissions', Icon: ShieldCheck }].map(({ x, y, label, detail, Icon }, index) => <g key={label} transform={`translate(${x} ${y})`}>
      <ellipse className={styles.ground} cx="0" cy="52" rx="43" ry="12" />
      <path className={styles.tokenEdge} d="M-38 0A38 38 0 0 0 38 0V9A38 38 0 0 1-38 9Z" />
      <circle className={styles.token} cy="0" r="38" />
      <Icon x={-15} y={-15} width={30} height={30} className={styles.icon} aria-hidden="true" />
      <text className={styles.overline} x="0" y="-62" textAnchor="middle">0{index + 1}</text>
      <text className={styles.body} x="0" y="85" textAnchor="middle">{label}</text>
      <text className={styles.small} x="0" y="108" textAnchor="middle">{detail}</text>
    </g>)}
    <g transform="translate(461 111)"><circle className={styles.lockDisc} r="29" /><LockKeyhole x={-12} y={-12} width={24} height={24} className={styles.icon} aria-hidden="true" /><text className={styles.small} x="0" y="84" textAnchor="middle">World</text><text className={styles.small} x="0" y="107" textAnchor="middle">Paused</text></g>
    <path className={styles.rule} d="M55 255H485" />
    <text className={styles.label} x="270" y="290" textAnchor="middle">Your choices come before an introduction.</text>
  </>;
}
