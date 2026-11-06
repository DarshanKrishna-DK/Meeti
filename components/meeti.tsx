'use client';

import Link from 'next/link';
import Image from 'next/image';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronRight, Compass, Fingerprint, Globe2, Handshake, Layers3, LockKeyhole, LogOut, Menu, MessageCircle, Plus, RefreshCw, Settings2, ShieldCheck, Sparkles, Users, X, Zap } from 'lucide-react';
import type { AppState } from '@/packages/shared/src';
import { ConnectionInstrument } from './connection-instrument';
import { Activity, Approvals, Auth, Brand, Discovery, Rooms, Settings, Tag, Verifier, WalletPanel, api, type Shared } from './workspace-features';
import { AgentStudio } from './agent-studio';
import { ProfileEditor } from './profile-editor';
import { Intents } from './intent-composer';

const navigation = [
  ['dashboard', 'Your space', Layers3], ['profile', 'Your profile', Users],
  ['agent', 'Agent studio', Sparkles], ['intents', 'Your intents', Zap],
  ['discover', 'Discover', Compass], ['activity', 'Agent exchange', MessageCircle],
  ['approvals', 'Approvals', Handshake], ['introductions', 'Introductions', LockKeyhole],
] as const;

const pageCopy: Record<string, { title: string; description: string }> = {
  dashboard: { title: 'A little intention. A new beginning.', description: 'Your people, your possibilities, your pace.' },
  profile: { title: 'The person behind your agent.', description: 'Give your representative useful context. You choose what becomes public.' },
  agent: { title: 'Your agent. Your ground rules.', description: 'A named representative with permissions you can inspect, change and revoke.' },
  intents: { title: 'Put your intention into words.', description: 'Shape a public request, review its details and decide when it can be discovered.' },
  discover: { title: 'Find a reason to connect.', description: 'Explore active intentions from Arkiv. A possible match is a beginning, not a decision.' },
  activity: { title: 'Before the first hello.', description: 'Read the real agent exchange and see where your sharing boundaries were applied.' },
  approvals: { title: 'The next move is yours.', description: 'Review the context and decide whether this introduction is right for you.' },
  introductions: { title: 'Room for a real conversation.', description: 'Private introductions open only after both decisions and every release gate pass.' },
  settings: { title: 'Keep your space in your hands.', description: 'Review account activity, provider status, wallet operations and your private data.' },
  verify: { title: 'Check the permission yourself.', description: 'Resolve current ENS authority directly, independently of a saved application status.' },
};

export function Landing() {
  return <div className="landing">
    <a className="skip-link" href="#landing-content">Skip to content</a>
    <header className="landing-nav"><Brand /><nav aria-label="Main navigation"><a href="#how">How it works</a><a href="#privacy">Your boundaries</a><Link href="/dashboard">Sign in <ArrowUpRight size={15} /></Link></nav></header>
    <main id="landing-content">
      <section className="hero">
        <div className="hero-copy"><span className="intro-line"><span className="status-dot" /> A more thoughtful way to meet</span><h1>Good people.<br />Clear intent.<br />Real possibility.</h1><p>Tell your agent what you bring and who you hope to meet. It explores the fit. You decide who gets a hello.</p><Link className="button" href="/dashboard">Make room for a connection <ArrowUpRight size={18} /></Link><span className="hero-foot"><LockKeyhole size={15} /> Private context. Public intention. Your permission.</span></div>
        <div className="hero-figure"><ConnectionInstrument /></div>
      </section>
      <section className="belief-strip" aria-label="Product foundations"><span className="belief-lead">An introduction has a few good boundaries.</span><span><Fingerprint size={19} /> ENS identity & permissions</span><span><Globe2 size={19} /> Arkiv live discovery</span><span><LockKeyhole size={18} /> Protected release</span></section>
      <section id="how" className="how-section"><div className="section-introduction"><span className="section-note">From a thought to a thoughtful hello</span><h2>A clear reason.<br />A connection worth exploring.</h2><p>Networking starts with what you want to do together, rather than another profile to scroll past.</p></div><div className="workflow-story">{[
        { Icon: Sparkles, title: 'Start with what matters to you.', copy: 'Give your agent context about what you seek and offer. Choose the fields it may use and keep the rest private.' },
        { Icon: Compass, title: 'Put a clear intention out there.', copy: 'Review a time-limited public request. Discovery finds complementary needs, then agents explore the context within your permissions.' },
        { Icon: Handshake, title: 'Keep the final decision.', copy: 'Read the exchange and decide for yourself. Both people must approve, and protected release stays locked until every gate passes.' },
      ].map(({ Icon, title, copy }, index) => <article key={title}><span className="workflow-marker">{index + 1}</span><div><Icon size={25} /><h3>{title}</h3><p>{copy}</p></div></article>)}</div></section>
      <section className="intent-editorial" aria-labelledby="intent-examples-title"><div><span className="section-note">One intention. Many possibilities.</span><h2 id="intent-examples-title">What could a good<br />connection make possible?</h2></div><div className="example-requests"><p><span>Build together</span>“I want to meet a cofounder who cares about making developer tools more accessible.”</p><p><span>Share a perspective</span>“I can offer product design feedback to a team building something useful.”</p><p><span>Find your next chapter</span>“I am looking for developer relations work with an open-source team.”</p><small>Example intentions, not live people or discovery results.</small></div></section>
      <section id="privacy" className="privacy-section"><div className="privacy-monogram"><Image src="/meeti-logo.png" width={993} height={841} sizes="(max-width: 767px) 145px, 180px" style={{height:'auto'}} alt="" /></div><div><span className="section-note">Connection starts with trust in your own boundaries</span><h2>Your agent can explore.<br />It cannot say yes for you.</h2><p>Contact details, private conversations and memories stay off public records. You can inspect permissions, pause your agent and revoke its access.</p><Link href="/verify" className="text-link">Inspect live permissions <ArrowUpRight size={16} /></Link></div></section>
      <section className="closing-invitation"><div><h2>Your next hello can<br />start with an intention.</h2><p>Bring a little curiosity. Keep control of the rest.</p></div><Link className="button" href="/dashboard">Enter your space <ArrowUpRight size={18} /></Link></section>
    </main>
    <footer className="landing-footer"><Brand /><p>Good connections begin with permission.</p><span>Testnet MVP. World release is paused.</span></footer>
  </div>;
}

export function Workspace({ view }: { view: string }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobile, setMobile] = useState(false);
  const [selected, setSelected] = useState('');
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const navElement = useRef<HTMLElement>(null);
  const requestInFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const authenticated = useRef(false);
  const refreshEpoch = useRef(0);
  const queuedRefresh = useRef(false);

  const refresh = useCallback(function refreshState(forAction = false): Promise<void> {
    if (busyRef.current && !forAction) return Promise.resolve();
    if (requestInFlight.current) { queuedRefresh.current = true; return requestInFlight.current; }
    const epoch = refreshEpoch.current;
    const request = (async () => {
      try {
        const next = await api<AppState>('state');
        if (!mounted.current || epoch !== refreshEpoch.current) return;
        setState(next);
        authenticated.current = true;
        setLastSynced(new Date());
      } catch (failure) {
        if (!mounted.current || epoch !== refreshEpoch.current) return;
        const message = failure instanceof Error ? failure.message : 'The workspace could not refresh. Try again.';
        if (/sign|auth|session|log in/i.test(message)) { setState(null); authenticated.current = false; }
        else setError(message);
      } finally { if (mounted.current) setLoading(false); }
    })();
    requestInFlight.current = request;
    void request.finally(() => {
      if (requestInFlight.current === request) requestInFlight.current = null;
      if (queuedRefresh.current && mounted.current && !busyRef.current && authenticated.current && document.visibilityState === 'visible') {
        queuedRefresh.current = false;
        void refreshState();
      }
    });
    return request;
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const update = () => { if (document.visibilityState === 'visible' && !busyRef.current && authenticated.current) void refresh(); };
    const interval = window.setInterval(update, 12000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { mounted.current = false; clearInterval(interval); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, [refresh]);

  useEffect(() => {
    if (!mobile) return;
    const beforeOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () => Array.from(navElement.current?.querySelectorAll<HTMLElement>('a, button:not(:disabled)') || []);
    focusables()[0]?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMobile(false); menuToggle.current?.focus(); }
      if (event.key === 'Tab') {
        const items = focusables();
        if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => { document.body.style.overflow = beforeOverflow; window.removeEventListener('keydown', keyboard); };
  }, [mobile]);

  async function run(operation: () => Promise<unknown>, message?: string) {
    if (busyRef.current) return;
    const priorRead = requestInFlight.current;
    refreshEpoch.current += 1;
    queuedRefresh.current = false;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); if (mounted.current) { if (message) setNotice(message); await priorRead; await refresh(true); } }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'This action could not finish. Try again.'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }

  const current = pageCopy[view] || pageCopy.dashboard;
  const pending = state?.proposals.filter(proposal => !proposal.myConsent).length || 0;
  const closeMenu = () => { setMobile(false); menuToggle.current?.focus(); };
  let content: ReactNode;
  if (loading) content = <WorkspaceSkeleton />;
  else if (view === 'verify') content = <Verifier busy={busy} run={run} />;
  else if (!state) content = <Auth run={run} busy={busy} />;
  else {
    const common = { state, run, busy };
    const routes: Record<string, ReactNode> = { profile: <ProfileEditor {...common} />, agent: <AgentStudio {...common} />, intents: <Intents {...common} />, discover: <Discovery {...common} />, activity: <Activity {...common} />, approvals: <Approvals {...common} />, introductions: <Rooms {...common} selected={selected} setSelected={setSelected} />, settings: <Settings {...common} /> };
    content = <div key={state.user.id} className={`screen-content screen-${view}`}>{routes[view] || <Overview {...common} />}</div>;
  }

  return <div className="workspace">
    <a className="skip-link" href="#workspace-content">Skip to content</a>
    {mobile && <button className="navigation-scrim" aria-label="Close navigation overlay" onClick={closeMenu} />}
    <aside id="meeti-navigation" ref={navElement} aria-label="Workspace navigation" className={`sidebar ${mobile ? 'open' : ''}`} onClick={event => { if ((event.target as HTMLElement).closest('a')) setMobile(false); }}>
      <div className="sidebar-brand"><Brand /><button className="mobile-close icon-button" aria-label="Close navigation" onClick={closeMenu}><X size={21} /></button></div>
      <div className="space-label">Your personal networking studio</div>
      <nav>{navigation.map(([path, label, Icon]) => <Link href={`/${path}`} key={path} aria-current={view === path ? 'page' : undefined} className={view === path ? 'active' : ''}><Icon size={19} /><span>{label}</span>{path === 'approvals' && pending > 0 && <span className="nav-count">{pending}</span>}</Link>)}</nav>
      <div className="sidebar-bottom"><Link href="/verify" className={view === 'verify' ? 'active' : ''}><ShieldCheck size={18} /> Independent verifier</Link><Link href="/settings" className={view === 'settings' ? 'active' : ''}><Settings2 size={18} /> Settings & audit</Link><div className="privacy-note"><LockKeyhole size={20} /><p>A little possibility.<br /><strong>Clear boundaries.</strong></p></div><div className="account-mini" aria-label="Signed-in account"><span className="avatar small">{state?.profile.displayName?.slice(0, 1) || 'Y'}</span><div><strong>{state?.profile.displayName || 'Your workspace'}</strong><small>{state ? 'Private account' : 'Sign in to begin'}</small></div>{state && <button className="icon-button" aria-label="Sign out" disabled={busy} onClick={() => { setState(null); authenticated.current = false; setSelected(''); void run(() => api('auth/logout', {})); }}><LogOut size={18} /></button>}</div></div>
    </aside>
    <div className="workspace-body">
      <header className="topbar"><button ref={menuToggle} className="mobile-menu icon-button" aria-label="Open navigation" aria-expanded={mobile} aria-controls="meeti-navigation" onClick={() => setMobile(true)}><Menu size={23} /></button><span className="breadcrumb"><Link href="/dashboard">Your space</Link><ChevronRight size={14} /><strong>{navigation.find(item => item[0] === view)?.[1] || (view === 'verify' ? 'Independent verifier' : 'Settings')}</strong></span><div className="topbar-actions"><span className="network-badge">ENS: Sepolia <span aria-hidden="true">/</span> Arkiv: Rabdi</span>{state && <button className="icon-button" aria-label="Refresh workspace" disabled={busy} onClick={() => void refresh()}><RefreshCw size={17} /></button>}</div></header>
      <main className="workspace-main" id="workspace-content" tabIndex={-1} aria-busy={busy}>
        <div className="page-heading"><div>{view === 'dashboard' && state && <span className="section-note">Welcome{state.profile.displayName ? `, ${state.profile.displayName.split(' ')[0]}` : ''}</span>}<h1>{current.title}</h1><p>{current.description}</p></div>{state && view === 'dashboard' && <Link className="button" href="/intents"><Plus size={17} /> Create an intent</Link>}</div>
        {error && <div className="alert error" role="alert"><ShieldCheck size={20} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={18} /></button></div>}
        {notice && <div className="alert" role="status"><Check size={20} /><span>{notice}</span><button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={18} /></button></div>}
        {busy && <div className="busy-status" role="status"><span className="busy-line" /><div><strong>Checking the details.</strong><span>Live network and agent requests can take a few minutes. Your decision and privacy gates still apply.</span></div></div>}
        <fieldset disabled={busy} className="workspace-controls" aria-label="Workspace controls" aria-busy={busy}>{content}</fieldset>
      </main>
      <footer className="workspace-footer"><span><LockKeyhole size={14} /> Connected by choice.</span>{state && lastSynced && <span className="sync-note">Updated {lastSynced.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Changes sync while this page is visible.</span>}</footer>
    </div>
  </div>;
}

function WorkspaceSkeleton() {
  return <section className="workspace-skeleton" aria-label="Loading your private workspace" role="status"><span className="sr-only">Loading your private workspace.</span><div className="skeleton-wide" /><div className="skeleton-columns"><div /><div /></div><div className="skeleton-wide short" /></section>;
}

function Overview({ state, run, busy }: Shared) {
  const steps = [
    { title: 'A profile that sounds like you', copy: 'What you offer, what you seek and what stays private.', done: !!state.profile.displayName, href: '/profile', Icon: Users },
    { title: 'An agent with clear boundaries', copy: 'Give your representative a name and scoped permission.', done: !!state.agent?.authority?.allowed, href: '/agent', Icon: Fingerprint },
    { title: 'An intention worth discovering', copy: 'Review public fields, then approve an expiring Arkiv record.', done: state.intents.some(intent => intent.status === 'published'), href: '/intents', Icon: Zap },
  ];
  const published = state.intents.filter(intent => intent.status === 'published');
  const waiting = state.proposals.filter(proposal => !proposal.myConsent);
  const next = steps.find(step => !step.done);
  return <>
    <div className="overview-grid"><section className="start-card panel"><span className="section-note">The next good connection starts with your intention</span><h2>Somewhere out there,<br />someone needs<br />what you bring.</h2><p>Give them a reason to find you. Your agent can explore the context while you keep the final say.</p><Link className="button" href={next?.href || '/discover'}>{next ? 'Continue your setup' : 'Explore connections'}<ArrowUpRight size={17} /></Link><div className="dashboard-summary"><span><strong>{published.length}</strong> active intentions</span><Link href="/approvals"><strong>{waiting.length}</strong> decisions awaiting you <ArrowRight size={15} /></Link></div></section><section className="panel your-agent"><div className="panel-title"><h2>Your representative</h2><Link className="icon-button" href="/agent" aria-label="Open agent studio"><ArrowUpRight size={19} /></Link></div><div className="agent-identity"><Image src="/meeti-logo.png" width={993} height={841} sizes="78px" style={{width:78,height:'auto'}} alt="" /><span className="identity-rule" /></div><h3>{state.agent?.ensName || 'An agent with your name on it.'}</h3><p>{state.agent?.persona || 'Your interests, your voice and a clear set of boundaries.'}</p><Tag good={!!state.agent?.authority?.allowed}>{state.agent?.authority?.allowed ? 'Last authority check allowed' : state.agent ? 'Authority needs verification' : 'Not configured'}</Tag>{state.agent?.authority?.checkedAt && <small className="authority-time">Checked {new Date(state.agent.authority.checkedAt).toLocaleString()}</small>}<div className="agent-footer"><span><LockKeyhole size={14} /> Owner controlled</span><Link href="/agent">{state.agent ? 'Manage agent' : 'Set up agent'} <ArrowRight size={15} /></Link></div></section></div>
    <section className="setup-guide panel" aria-label="Your connection setup"><div className="setup-guide-title"><div><h2>A few steps toward your people.</h2><p>Pick up where you left off.</p></div><Tag>{steps.filter(step => step.done).length} of 3 ready</Tag></div><ol>{steps.map((step, index) => <li key={step.title}><span className={`step-number ${step.done ? 'done' : ''}`}>{step.done ? <Check size={18} aria-label="Complete" /> : index + 1}</span><div><Link href={step.href}>{step.title}<ArrowUpRight size={15} /></Link><p>{step.copy}</p></div><step.Icon size={22} className="setup-step-icon" /></li>)}</ol></section>
    <div className="bottom-grid"><section className="panel connections-panel"><div className="panel-title"><h2>Room for a new connection</h2><Tag>{state.rooms.length} introductions</Tag></div>{state.rooms.length ? <div className="list">{state.rooms.map(room => <Link className="list-row" href="/introductions" key={room.id}><Handshake size={22} /><span><strong>{room.title}</strong><small>{new Date(room.createdAt).toLocaleDateString()}</small></span><ChevronRight size={17} /></Link>)}</div> : <div className="dashboard-empty"><Handshake size={35} strokeWidth={1.4} /><h3>Your next hello is still ahead.</h3><p>Both people decide before an introduction. While World verification is paused, protected rooms remain locked.</p><Link className="text-link" href={published.length ? '/discover' : '/intents'}>{published.length ? 'Find a reason to connect' : 'Shape your first intent'}<ArrowUpRight size={16} /></Link></div>}</section><section className="panel integrations"><div className="panel-title"><h2>The foundations</h2><Link className="icon-button" href="/settings" aria-label="View integration diagnostics"><Settings2 size={19} /></Link></div>{Object.entries(state.integrations).map(([name, status]) => <div className="integration-row" key={name}><span className="integration-icon">{name === 'ens' ? <Fingerprint size={21} /> : name === 'arkiv' ? <Globe2 size={21} /> : name === 'ai' ? <Sparkles size={21} /> : <ShieldCheck size={21} />}</span><div><strong>{name === 'ens' ? 'ENS identity' : name === 'arkiv' ? 'Arkiv discovery' : name === 'ai' ? 'Agent reasoning' : 'World release'}</strong><small>{status.message}</small></div><span className={`tiny-status ${status.status === 'ready' ? 'ready' : ''}`}>{status.status === 'deferred' ? 'paused' : status.status === 'ready' ? 'configured' : status.status}</span></div>)}</section></div>
    <WalletPanel state={state} run={run} busy={busy} />
  </>;
}
