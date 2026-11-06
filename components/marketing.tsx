'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Compass, Fingerprint, Handshake, Menu, MessageCircle, ShieldCheck, Users, Wallet, X } from 'lucide-react';
import { MEETI_TAGLINE } from '@/packages/shared/src/brand';
import { Brand } from './workspace-features';
import { ConnectionInstrument } from './connection-instrument';
import { ProductDiagram } from './product-diagrams';
import { ThemeToggle } from './theme-toggle';

const foundations = [
  { text: 'A clear reason to meet', mark: 'fold' },
  { text: 'Identity with ENS', mark: 'weave' },
  { text: 'Discovery with Arkiv', mark: 'orbit' },
  { text: 'Mutual permission', mark: 'join' },
] as const;

function FoundationMark({ kind }: { kind: typeof foundations[number]['mark'] }) {
  return <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    {kind === 'fold' && <><path d="M8 32 27 8l10 24-10 24Z"/><path d="m27 8 29 24-29 24 10-24Z"/><path d="M8 32h48"/></>}
    {kind === 'weave' && <><path d="M14 9c32 0 4 46 36 46M27 9c32 0 4 46 23 46M14 9C-5 9 23 55 14 55M27 9C8 9 36 55 27 55"/><path d="M9 19h43M12 32h40M12 45h43"/></>}
    {kind === 'orbit' && <><ellipse cx="32" cy="32" rx="25" ry="12" transform="rotate(-38 32 32)"/><ellipse cx="32" cy="32" rx="25" ry="12" transform="rotate(38 32 32)"/><path d="m32 21 9 11-9 11-9-11Z"/></>}
    {kind === 'join' && <><path d="M32 12C5-3 4 48 32 52M32 12c27-15 28 36 0 40"/><path d="M32 12C18 21 18 43 32 52M32 12c14 9 14 31 0 40"/><path d="M12 32h40"/></>}
  </svg>;
}

function FoundationsBelt() {
  const [paused, setPaused] = useState(false);
  return <section className="foundations-belt" aria-label="Product foundations" data-paused={paused}>
    <div className="foundations-window">
      <div className="foundations-track">
        {[false, true].map(repeat => <ul className="foundations-sequence" key={String(repeat)} aria-hidden={repeat || undefined}>
          {foundations.map(({ text, mark }) => <li key={text}><FoundationMark kind={mark}/><span>{text}</span></li>)}
        </ul>)}
      </div>
    </div>
    <button className="belt-control" type="button" onClick={() => setPaused(!paused)} aria-label={paused ? 'Play the decorative foundations belt' : 'Pause the decorative foundations belt'}>{paused ? 'Play' : 'Pause'}</button>
  </section>;
}

export function Landing() {
  const [menu,setMenu]=useState(false);
  return <div className="landing">
    <a className="skip-link" href="#landing-content">Skip to content</a>
    <header className="landing-nav"><Brand/><button className="public-menu icon-button" aria-label={menu?'Close main navigation':'Open main navigation'} aria-expanded={menu} aria-controls="public-navigation" onClick={()=>setMenu(!menu)}>{menu?<X size={22}/>:<Menu size={22}/>}</button><nav id="public-navigation" className={menu?'is-open':''} aria-label="Main navigation" onClick={()=>setMenu(false)}><a href="#why">Why Meeti</a><a href="#features">What you can do</a><a href="#how">How it works</a><a href="#privacy">Privacy</a><Link className="button secondary" href="/dashboard">Find your people<ArrowUpRight size={15}/></Link></nav><ThemeToggle/></header>
    <main id="landing-content">
      <section className="hero"><div className="hero-copy"><h1>{MEETI_TAGLINE}</h1><p>There is someone who needs what you bring. Tell Meeti who you hope to meet, let your agent explore the fit, and keep the final hello in your hands.</p><div className="hero-actions"><Link className="button" href="/dashboard">Find your kind of connection<ArrowUpRight size={18}/></Link><a className="text-link" href="#how">Take a closer look<ArrowRight size={17}/></a></div><span className="hero-foot">Your context stays private. Your permission comes first.</span></div><div className="hero-figure"><ConnectionInstrument/></div></section>
      <FoundationsBelt/>
      <section id="why" className="product-section problem-section"><div className="product-copy"><span className="section-note">The problem with another cold hello</span><h2>More profiles.<br/>Less real connection.</h2><p>The right person can be a few introductions away. But endless scrolling, vague requests and messages without context make finding them feel like work.</p><p>You have something to offer. You need a better way to find the person it matters to.</p></div><ProductDiagram kind="problem"/></section>
      <section className="product-section solution-section"><ProductDiagram kind="solution"/><div className="product-copy"><span className="section-note">Meet with a reason</span><h2>A shared intention<br/>changes the conversation.</h2><p>Start with what you want to do together. Meeti turns that intention into a focused search, with an agent that can explore the context you allow.</p><p>You see why a connection could make sense. Both people decide before a protected introduction can open.</p><Link className="text-link" href="/dashboard">Make room for a possibility<ArrowUpRight size={17}/></Link></div></section>
      <section id="features" className="features-section"><div className="section-heading-public"><span className="section-note">Useful connections. Clear boundaries.</span><h2>A little help finding<br/>your kind of people.</h2><p>For the cofounder you have not met, the mentor with a different perspective, or the teammate who shares your curiosity.</p></div><div className="feature-grid">{[
        {Icon:Users,title:'A profile with a purpose',copy:'Share what you seek, what you can offer and the topics you care about. Choose each field that may become public.'},
        {Icon:Fingerprint,title:'Your agent, your boundaries',copy:'A real ENS identity and scoped permissions define what your representative can do. You can pause or revoke access.'},
        {Icon:Compass,title:'Find the complementary fit',copy:'Discover active, expiring intentions on Arkiv. Review compatibility reasons, evidence and uncertainty.'},
        {Icon:MessageCircle,title:'See the conversation',copy:'Read the actual agent exchange. Inspect permitted context and blocked disclosures before you make a decision.'},
        {Icon:Handshake,title:'A yes from both people',copy:'Your consent belongs to a specific proposal. Both people decide separately, and protected release requires every gate.'},
        {Icon:ShieldCheck,title:'Keep the private parts private',copy:'Contact details, employer, private chats and memories stay off ENS and Arkiv. AI cannot expand your permissions.'},
      ].map(({Icon,title,copy})=><article key={title}><span className="feature-icon"><Icon size={24}/></span><h3>{title}</h3><p>{copy}</p></article>)}</div></section>
      <section id="how" className="how-section"><div className="section-introduction"><span className="section-note">From a thought to a thoughtful hello</span><h2>Start small.<br/>See where it goes.</h2><p>A guided setup helps you get the essentials in place. Real network permissions and public publication always have their own review.</p><ProductDiagram kind="setup"/></div><div className="workflow-story">{[
        {Icon:Wallet,title:'Bring your wallet. Be yourself.',copy:'Sign in with MetaMask, then describe who you are, what you seek and what you offer. Your profile starts private.'},
        {Icon:Fingerprint,title:'Give your agent clear boundaries.',copy:'Connect a genuine ENS agent identity. Review its purpose, permitted fields, delegated actions and expiry.'},
        {Icon:Compass,title:'Put a clear intention out there.',copy:'Review the exact public version and its expiry. Approve the separate Arkiv publication in your wallet, then search live intentions.'},
        {Icon:Handshake,title:'Keep the final hello yours.',copy:'Read the permissioned exchange and make your own decision. Both consents, current authority and fresh World approval are required for release.'},
      ].map(({Icon,title,copy},i)=><article key={title}><span className="workflow-marker">0{i+1}</span><div><Icon size={24}/><h3>{title}</h3><p>{copy}</p></div></article>)}</div></section>
      <section className="intent-editorial"><div><span className="section-note">One intention. Many possibilities.</span><h2>What could a good<br/>connection make possible?</h2></div><div className="example-requests"><p><span>Build together</span>&quot;I am looking for a cofounder who cares about making developer tools more accessible.&quot;</p><p><span>Share a perspective</span>&quot;I can offer product design feedback to a team building something useful.&quot;</p><p><span>Find your people</span>&quot;I would like to meet a teammate for a climate technology project.&quot;</p><small>Example intentions. These are not live people or discovery results.</small></div></section>
      <section id="privacy" className="product-section privacy-section"><ProductDiagram kind="privacy"/><div className="product-copy"><span className="section-note">Your boundaries are part of the connection</span><h2>Your agent can explore.<br/>Only you can say yes.</h2><p>Private context is stored offchain. Only public fields you explicitly approve can travel to public records. Your agent cannot grant itself more permission.</p><p>Permissions are checked again on protected actions. Expired grants, provider failures and revocation stop new access. Public records and information already shared can persist.</p><Link className="text-link" href="/verify">Inspect live permissions<ArrowUpRight size={16}/></Link></div></section>
      <section className="closing-invitation"><div><span className="section-note">A good place to begin</span><h2>Your next hello<br/>starts with a little intent.</h2><p>Bring your curiosity. Keep your boundaries.</p></div><Link className="button" href="/dashboard">Find your people<ArrowUpRight size={18}/></Link></section>
    </main><footer className="landing-footer"><Brand/><p>{MEETI_TAGLINE}</p><span>Testnet MVP. World release is paused.</span></footer>
  </div>;
}
