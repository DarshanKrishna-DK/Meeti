'use client';

import { useEffect, useId, useRef } from 'react';
import styles from './guide-mascot.module.css';

/** Shaded SVG art. The gesture is guidance, never an account or verification status. */
export function GuideMascotArt({ className = '' }: { className?: string }) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const figure = useRef<SVGSVGElement>(null);
  const id = (part: string) => `${rawId}-guide-${part}`;
  const paint = (part: string) => `url(#${id(part)})`;
  useEffect(() => {
    const element = figure.current;
    if (!element) return;
    let inView = false;
    const update = () => { element.dataset.moving = String(inView && !document.hidden); };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      inView = entries[entries.length - 1]?.isIntersecting ?? false; update();
    });
    observer?.observe(element);
    document.addEventListener('visibilitychange', update);
    return () => { observer?.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, []);
  return <svg ref={figure} className={`mascot ${styles.figure} ${className}`} viewBox="0 0 300 224" aria-hidden="true" focusable="false" data-renderer="shaded-svg" data-moving="false">
    <defs>
      <radialGradient id={id('rose')} cx="28%" cy="17%" r="88%"><stop stopColor="var(--guide-rose-light)"/><stop offset=".38" stopColor="var(--guide-rose)"/><stop offset=".76" stopColor="var(--guide-rose-shade)"/><stop offset="1" stopColor="var(--guide-rose-deep)"/></radialGradient>
      <radialGradient id={id('pearl')} cx="26%" cy="14%" r="88%"><stop stopColor="var(--guide-pearl-light)"/><stop offset=".38" stopColor="var(--guide-pearl)"/><stop offset=".76" stopColor="var(--guide-pearl-shade)"/><stop offset="1" stopColor="var(--guide-pearl-deep)"/></radialGradient>
      <radialGradient id={id('plum')} cx="26%" cy="16%" r="90%"><stop stopColor="#82718f"/><stop offset=".3" stopColor="#504056"/><stop offset=".74" stopColor="#2c2338"/><stop offset="1" stopColor="#18131f"/></radialGradient>
      <linearGradient id={id('glass')} x1="10%" y1="0%" x2="75%" y2="100%"><stop stopColor="#6c5a79"/><stop offset=".36" stopColor="#34283f"/><stop offset="1" stopColor="#1a1423"/></linearGradient>
      <linearGradient id={id('rim')} x1="0%" y1="0%" x2="80%" y2="100%"><stop stopColor="var(--guide-pearl-light)"/><stop offset=".45" stopColor="var(--guide-rose)"/><stop offset="1" stopColor="var(--guide-rose-deep)"/></linearGradient>
      <linearGradient id={id('shine')} x1="0%" y1="0%" x2="30%" y2="100%"><stop stopColor="#fff" stopOpacity=".75"/><stop offset="1" stopColor="#fff" stopOpacity="0"/></linearGradient>
      <radialGradient id={id('shadow')}><stop stopColor="var(--guide-shadow)" stopOpacity=".3"/><stop offset="1" stopColor="var(--guide-shadow)" stopOpacity="0"/></radialGradient>
      <clipPath id={id('visor-clip')}><path d="M111 58C127 47 165 46 183 56C190 60 191 78 185 86C172 101 122 103 110 89C104 82 104 64 111 58Z"/></clipPath>
    </defs>
    <ellipse cx="151" cy="207" rx="97" ry="13" fill={paint('shadow')}/>
    {/* Back shell, recessed vents and the far arm sit behind the torso. */}
    <rect x="88" y="117" width="43" height="58" rx="18" fill={paint('plum')}/>
    <path d="M96 128v29" stroke="#ad98b1" strokeOpacity=".32" strokeWidth="2" strokeLinecap="round"/>
    {[0,1,2].map(row=><rect key={row} x="97" y={135+row*7} width="10" height="2.5" rx="1.25" fill="#18131f"/>)}
    <circle cx="101" cy="139" r="12" fill={paint('plum')}/>
    <path d="M93 139C87 147 86 158 92 168" fill="none" stroke={paint('pearl')} strokeWidth="14" strokeLinecap="round"/>
    <ellipse cx="94" cy="170" rx="9" ry="11" transform="rotate(-22 94 170)" fill={paint('rose')}/>
    <path d="m91 171 2 5m3-7 2 5" stroke="var(--guide-rose-deep)" strokeOpacity=".45" strokeWidth="1.2" strokeLinecap="round"/>
    {/* Rounded soles and ankle collars keep the character grounded. */}
    <rect x="112" y="174" width="15" height="22" rx="7" fill={paint('plum')}/>
    <rect x="158" y="174" width="15" height="22" rx="7" fill={paint('plum')}/>
    <path d="M97 194C102 185 124 183 134 191C139 195 139 203 131 205H102C96 204 94 200 97 194Z" fill={paint('plum')}/>
    <path d="M152 194C157 185 180 183 190 191C195 195 195 203 187 205H158C151 204 149 200 152 194Z" fill={paint('plum')}/>
    <path d="M99 194C108 187 124 187 132 193L132 197C123 193 108 193 99 197Z" fill={paint('pearl')}/>
    <path d="M154 194C164 187 180 187 188 193L188 197C179 193 163 193 154 197Z" fill={paint('pearl')}/>
    <path d="M102 202h26m29 0h27" stroke="#a68caa" strokeOpacity=".4" strokeWidth="1.2" strokeLinecap="round"/>
    {/* Four-tone shell, a seated front panel and an embossed connection mark. */}
    <path d="M101 131C101 113 117 105 144 105C171 105 190 114 193 135L191 163C188 182 170 190 144 188C117 187 102 178 100 161Z" fill={paint('rose')} stroke="var(--guide-rose-deep)" strokeOpacity=".36"/>
    <path d="M174 114C188 123 192 143 187 165C184 178 170 184 157 185C180 185 192 176 194 161L195 137C194 126 187 118 174 114Z" fill="var(--guide-rose-deep)" opacity=".35"/>
    <path d="M111 126C115 115 133 111 153 113" fill="none" stroke={paint('shine')} strokeWidth="4" strokeLinecap="round"/>
    <path d="M102 154C121 169 167 173 192 154" fill="none" stroke="var(--guide-rose-deep)" strokeOpacity=".26" strokeWidth="1.1"/>
    <path d="M122 131C132 124 155 124 166 132L166 156C156 163 134 163 122 155Z" fill={paint('rim')}/>
    <path d="M125 133C137 127 154 128 163 134L163 154C151 160 135 159 125 153Z" fill={paint('plum')}/>
    <path d="M134 149v-10c0-3 3-4 5-1l5 7 5-7c2-3 5-2 5 1v10" fill="none" stroke="var(--guide-eye)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
    {[112,177].map(x=><g key={x}><circle cx={x} cy="157" r="2.3" fill="var(--guide-rose-deep)" opacity=".48"/><path d={`m${x-1} 157h2`} stroke="var(--guide-pearl-light)" strokeOpacity=".65" strokeWidth=".7"/></g>)}
    <rect x="132" y="174" width="26" height="3" rx="1.5" fill="var(--guide-rose-deep)" opacity=".3"/>
    <circle cx="144" cy="109" r="12" fill={paint('plum')}/>
    <ellipse cx="144" cy="108" rx="12" ry="5" fill={paint('rim')}/>
    <g className={styles.hand}>
      <circle cx="190" cy="135" r="12" fill={paint('plum')}/>
      <circle cx="189" cy="133" r="8" fill={paint('rim')}/>
      <circle cx="189" cy="133" r="3" fill={paint('plum')}/>
      <path d="M199 135l17 6" stroke={paint('rose')} strokeWidth="15" strokeLinecap="round"/>
      <circle cx="217" cy="141" r="9" fill={paint('plum')}/>
      <circle cx="216" cy="139" r="4" fill={paint('rim')}/>
      <path d="m223 136 17-17" stroke={paint('pearl')} strokeWidth="13" strokeLinecap="round"/>
      <path d="m225 132 12-12" stroke="#fff" strokeOpacity=".3" strokeWidth="2" strokeLinecap="round"/>
      <ellipse cx="241" cy="119" rx="8" ry="6" transform="rotate(-38 241 119)" fill={paint('plum')}/>
      <path d="M240 116c0-5 4-8 8-7l15 4c5 1 5 7 0 8l-6 1-4 9c-2 4-7 4-9 0l-4-6Z" fill={paint('rose')}/>
      <path d="m252 113 20-8c5-2 8 4 4 7l-17 10" fill={paint('pearl')}/>
      <path d="m245 119 6 3m-7 2 5 3" stroke="var(--guide-rose-deep)" strokeOpacity=".4" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="m258 111 13-5" stroke="#fff" strokeOpacity=".45" strokeWidth="1.5" strokeLinecap="round"/>
    </g>
    <g className={styles.head}>
      <ellipse cx="92" cy="74" rx="11" ry="14" fill={paint('plum')}/>
      <ellipse cx="91" cy="72" rx="7" ry="10" fill={paint('rim')}/>
      <ellipse cx="198" cy="69" rx="11" ry="14" fill={paint('plum')}/>
      <ellipse cx="200" cy="67" rx="7" ry="10" fill={paint('rim')}/>
      <path d="M94 67C93 38 111 22 143 21C177 20 198 35 199 62L198 78C196 102 175 115 145 115C113 115 94 103 93 81Z" fill={paint('pearl')} stroke="var(--guide-pearl-deep)" strokeOpacity=".38"/>
      <path d="M181 31C195 51 197 77 186 95C179 106 165 111 149 112C179 113 198 99 200 78V61C199 48 192 37 181 31Z" fill="var(--guide-pearl-deep)" opacity=".25"/>
      <path d="M106 47C114 34 133 29 155 31" stroke={paint('shine')} strokeWidth="6" fill="none" strokeLinecap="round"/>
      <path d="M108 56C125 43 166 43 185 54C194 59 196 80 188 90C173 107 120 108 107 92C100 84 100 63 108 56Z" fill={paint('rim')}/>
      <path d="M111 58C127 47 165 46 183 56C190 60 191 78 185 86C172 101 122 103 110 89C104 82 104 64 111 58Z" fill={paint('glass')}/>
      <g clipPath={paint('visor-clip')}><path d="M105 55C124 43 155 48 171 55L115 91C105 83 101 68 105 55Z" fill={paint('shine')} opacity=".2"/>
        <g className={styles.eyes}><rect x="122" y="65" width="9" height="16" rx="4.5" fill="var(--guide-eye)"/><rect x="158" y="63" width="9" height="16" rx="4.5" fill="var(--guide-eye)"/><circle cx="125" cy="68" r="1.6" fill="#fff"/><circle cx="161" cy="66" r="1.6" fill="#fff"/></g>
        <path d="M137 86q8 6 15-1" fill="none" stroke="var(--guide-eye)" strokeWidth="2.4" strokeLinecap="round"/>
      </g>
      <path d="M111 58C127 47 165 46 183 56" fill="none" stroke="#fff" strokeOpacity=".4" strokeWidth="1.1"/>
      <circle cx="98" cy="77" r="1.7" fill="var(--guide-pearl-deep)"/><circle cx="193" cy="72" r="1.7" fill="var(--guide-pearl-deep)"/>
    </g>
  </svg>;
}
