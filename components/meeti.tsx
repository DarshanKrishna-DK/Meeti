'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowRight, ArrowUpRight, Check, ChevronRight, Compass, Fingerprint, Globe2, Handshake, Layers3, LockKeyhole, LogOut, Menu, MessageCircle, RefreshCw, Settings2, ShieldCheck, Sparkles, Users, X, Zap, PanelLeftClose, PanelLeftOpen, CircleHelp, ChartLine, Workflow } from 'lucide-react';
import type { AppState } from '@/packages/shared/src';
import { SetupFlow, WorkspaceTour } from './setup-flow';
import { Activity, Approvals, Auth, Brand, Discovery, Rooms, Settings, Tag, Verifier, api, type Shared } from './workspace-features';
import { AgentStudio } from './agent-studio';
import { ProfileEditor } from './profile-editor';
import { Intents } from './intent-composer';
import { ThemeToggle } from './theme-toggle';

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

export { Landing } from './marketing';

const sidebarMemory = new Map<string, boolean>();
const sidebarPreferenceEvent = 'meeti-navigation-preference';
function subscribeSidebarPreference(update: () => void) {
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null) sidebarMemory.clear();
    else sidebarMemory.delete(event.key);
    update();
  };
  window.addEventListener('storage', storageChanged);
  window.addEventListener(sidebarPreferenceEvent, update);
  return () => {
    window.removeEventListener('storage', storageChanged);
    window.removeEventListener(sidebarPreferenceEvent, update);
  };
}
function useSidebarPreference(userId: string | undefined): [boolean, (value: boolean) => void] {
  const key = `meeti.sidebar.collapsed.${userId || 'guest'}`;
  const read = useCallback(() => {
    if (sidebarMemory.has(key)) return sidebarMemory.get(key) || false;
    try {
      const value = window.localStorage.getItem(key);
      if (value === 'true' || value === 'false') return value === 'true';
    } catch { /* The in-memory preference remains available when browser storage is blocked. */ }
    return sidebarMemory.get(key) || false;
  }, [key]);
  const collapsed = useSyncExternalStore(subscribeSidebarPreference, read, () => false);
  const save = useCallback((value: boolean) => {
    sidebarMemory.set(key, value);
    try { window.localStorage.setItem(key, String(value)); }
    catch { /* Only this presentation preference is kept in memory if persistence is unavailable. */ }
    window.dispatchEvent(new Event(sidebarPreferenceEvent));
  }, [key]);
  return [collapsed, save];
}

export function Workspace({ view }: { view: string }) {
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mobile, setMobile] = useState(false);
  const [collapsed, setCollapsed] = useSidebarPreference(state?.user.id);
  const [setup, setSetup] = useState(false);
  const [tour, setTour] = useState(false);
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

  const tourUser = state?.user.id;
  useEffect(() => {
    if (!tourUser) return;
    let active = true;
    void api<{tourCompleted:boolean}>('onboarding').then(result => { if(active && !result.tourCompleted) setTour(true); }).catch(() => { /* Setup remains available if the tour preference cannot be read. */ });
    return () => { active = false; };
  }, [tourUser]);

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
    const common = { state, run, busy, refresh };
    const routes: Record<string, ReactNode> = { profile: <ProfileEditor {...common} />, agent: <AgentStudio {...common} />, intents: <Intents {...common} />, discover: <Discovery {...common} />, activity: <Activity {...common} />, approvals: <Approvals {...common} />, introductions: <Rooms {...common} selected={selected} setSelected={setSelected} />, settings: <Settings {...common} /> };
    content = <div key={state.user.id} className={`screen-content screen-${view}`}>{routes[view] || <Overview {...common} openSetup={()=>setSetup(true)} />}</div>;
  }

  return <div className={`workspace ${collapsed ? 'sidebar-collapsed' : ''}`}>
    <a className="skip-link" href="#workspace-content">Skip to content</a>
    {mobile && <button className="navigation-scrim" aria-label="Close navigation overlay" onClick={closeMenu} />}
    <aside id="meeti-navigation" ref={navElement} aria-label="Workspace navigation" className={`sidebar ${mobile ? 'open' : ''}`} onClick={event => { if ((event.target as HTMLElement).closest('a')) setMobile(false); }}>
      <div className="sidebar-brand"><Brand /><button className="desktop-collapse icon-button" aria-label={collapsed?'Expand navigation':'Collapse navigation'} aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}>{collapsed?<PanelLeftOpen size={19}/>:<PanelLeftClose size={19}/>}</button><button className="mobile-close icon-button" aria-label="Close navigation" onClick={closeMenu}><X size={21} /></button></div>
      <div className="space-label">Your personal networking studio</div>
      <nav>{navigation.map(([path, label, Icon]) => <Link href={`/${path}`} key={path} aria-label={label} aria-current={view === path ? 'page' : undefined} className={view === path ? 'active' : ''} title={label}><Icon size={19} /><span>{label}</span>{path === 'approvals' && pending > 0 && <span className="nav-count">{pending}</span>}</Link>)}</nav>
      <div className="sidebar-bottom"><Link href="/verify" title="Independent verifier" aria-label="Independent verifier" className={view === 'verify' ? 'active' : ''}><ShieldCheck size={18} /><span>Independent verifier</span></Link><Link href="/settings" title="Settings and audit" aria-label="Settings and audit" className={view === 'settings' ? 'active' : ''}><Settings2 size={18} /><span>Settings and audit</span></Link><button className="tour-replay" title="Replay your workspace tour" onClick={()=>setTour(true)}><CircleHelp size={18}/><span>Take a quick tour</span></button><div className="privacy-note"><LockKeyhole size={20} /><p>A little possibility.<br /><strong>Clear boundaries.</strong></p></div><div className="account-mini" aria-label="Signed-in account"><span className="avatar small">{state?.profile.displayName?.slice(0, 1) || 'Y'}</span><div><strong>{state?.profile.displayName || 'Your workspace'}</strong><small>{state ? 'Private account' : 'Sign in to begin'}</small></div>{state && <button className="icon-button" aria-label="Sign out" disabled={busy} onClick={() => { setState(null); authenticated.current = false; setSelected(''); void run(() => api('auth/logout', {})); }}><LogOut size={18} /></button>}</div></div>
    </aside>
    <div className="workspace-body">
      <header className="topbar"><button ref={menuToggle} className="mobile-menu icon-button" aria-label="Open navigation" aria-expanded={mobile} aria-controls="meeti-navigation" onClick={() => setMobile(true)}><Menu size={23} /></button><span className="breadcrumb"><Link href="/dashboard">Your space</Link><ChevronRight size={14} /><strong>{navigation.find(item => item[0] === view)?.[1] || (view === 'verify' ? 'Independent verifier' : 'Settings')}</strong></span><div className="topbar-actions"><ThemeToggle/>{state && <button className="icon-button" aria-label="Refresh workspace" disabled={busy} onClick={() => void refresh()}><RefreshCw size={17} /></button>}</div></header>
      <main className="workspace-main" id="workspace-content" tabIndex={-1} aria-busy={busy}>
        <div className="page-heading"><div>{view === 'dashboard' && state && <span className="section-note">Welcome{state.profile.displayName ? `, ${state.profile.displayName.split(' ')[0]}` : ''}</span>}<h1>{current.title}</h1><p>{current.description}</p></div></div>
        {error && <div className="alert error" role="alert"><ShieldCheck size={20} /><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={18} /></button></div>}
        {notice && <div className="alert" role="status"><Check size={20} /><span>{notice}</span><button className="icon-button" aria-label="Dismiss notice" onClick={() => setNotice('')}><X size={18} /></button></div>}
        {busy && <div className="busy-status" role="status"><span className="busy-line" /><div><strong>Checking the details.</strong><span>Live network and agent requests can take a few minutes. Your decision and privacy gates still apply.</span></div></div>}
        <fieldset disabled={busy} className="workspace-controls" aria-label="Workspace controls" aria-busy={busy}>{content}</fieldset>
      </main>
      {state && setup && <SetupFlow state={state} run={run} busy={busy} onClose={()=>setSetup(false)}/>}
      {state && tour && <WorkspaceTour run={run} busy={busy} onClose={()=>setTour(false)} onSetup={()=>{setTour(false);setSetup(true);}}/>}
      <footer className="workspace-footer"><span><LockKeyhole size={14} /> Connected by choice.</span>{state && lastSynced && <span className="sync-note">Updated {lastSynced.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Changes sync while this page is visible.</span>}</footer>
    </div>
  </div>;
}

function WorkspaceSkeleton() {
  return <section className="workspace-skeleton" aria-label="Loading your private workspace" role="status"><span className="sr-only">Loading your private workspace.</span><div className="skeleton-wide" /><div className="skeleton-columns"><div /><div /></div><div className="skeleton-wide short" /></section>;
}

function Overview({ state, openSetup }: Shared & {openSetup:()=>void}) {
  const published = state.intents.filter(intent=>intent.status==='published');
  const decisions = state.proposals.filter(proposal=>!proposal.myConsent && ['proposed','waiting_consents'].includes(proposal.status));
  const leads = state.proposals.filter(proposal=>!['declined','revoked','expired','blocked'].includes(proposal.status));
  const steps=[{title:'Tell us a little about you',done:!!(state.profile.displayName.trim()&&state.profile.seeking.trim()&&state.profile.offering.trim())},{title:'Verify your ENS agent permissions',done:!!state.agent?.authority?.allowed},{title:'Publish your first intention',done:published.length>0}];
  return <><section className="dashboard-welcome panel"><div><span className="section-note">A little intention, a new possibility</span><h2>Your people are out there.<br/>Give them a reason to find you.</h2><p>Start with what you seek and what you bring. Your next step is ready when you are.</p><button className="button" onClick={openSetup}>{steps.every(s=>s.done)?'Review your setup':'Continue guided setup'}<ArrowUpRight size={17}/></button></div><div className="dashboard-setup"><span className="section-note">Your connection essentials</span>{steps.map((step,i)=><div key={step.title}><span className={`step-number ${step.done?'done':''}`}>{step.done?<Check size={16}/>:i+1}</span><span>{step.title}</span>{step.done&&<small>Saved</small>}</div>)}<p className="small-copy">Live permissions are checked again before protected actions.</p></div></section>
    <details className="advanced-overview panel"><summary>Present the testnet networking flow</summary><p>You are signed in with your wallet. Use two independently controlled accounts to show both sides. Every signature and transaction needs the owner to review it in MetaMask.</p><ol className="guided-checklist"><li><Link className="inline-link" href="/profile">Review your private profile</Link>: what you offer, what you seek and which context your agent may use.</li><li><Link className="inline-link" href="/agent">Open Agent Studio</Link>: import or configure your Sepolia ENS agent, separate delegate, permitted fields and expiry. Check current authority. A saved form does not grant permission.</li><li><Link className="inline-link" href="/intents">Compose a timebound intent</Link>: approve model processing, review the interpretation, correct requirements, choose topics and expiry, then approve the exact public fields.</li><li>In Your intents, save the draft and choose Review publication. Review the signing message, explicit fee budget and Rabdi testnet transaction. Confirm its actual receipt and Arkiv entity before continuing.</li><li><Link className="inline-link" href="/discover">Search live Arkiv intents</Link>: choose your published intent and Find connections. Review actual results and source references. Choose Ask agents to explore for an eligible candidate, or show the actual empty or blocked response. Run the same steps for the other account.</li><li><Link className="inline-link" href="/activity">Inspect the agent exchange</Link>: review the actual conversation, permitted context, unanswered questions and denied disclosures. Each owner answers only for their own account.</li></ol><p className="small-copy">World human verification is future scope and is not available in this demo. Do not present wallet ownership or an agent conversation as verified human identity. Protected release remains subject to the current server gates.</p><Link className="text-link" href="/settings">Inspect actual receipts and the operation journal<ArrowRight size={16}/></Link></details>
    <div className="dashboard-metrics"><Link className="panel" href="/intents"><span><Zap size={20}/>Active intents</span><strong>{published.length}</strong><small>Reviewed public intentions<ArrowUpRight size={16}/></small></Link><Link className="panel" href="/activity"><span><Users size={20}/>Connection leads</span><strong>{leads.length}</strong><small>From actual proposals<ArrowUpRight size={16}/></small></Link><Link className="panel" href="/approvals"><span><Handshake size={20}/>Your decisions</span><strong>{decisions.length}</strong><small>Waiting for your review<ArrowUpRight size={16}/></small></Link></div>
    <div className="bottom-grid"><section className="panel dashboard-section"><div className="panel-title"><h2>Your active intentions</h2><Link className="text-link" href="/intents">View all<ArrowUpRight size={15}/></Link></div>{published.length?published.slice(0,3).map(intent=><Link className="list-row" key={intent.id} href="/intents"><span className="icon-box"><Zap size={18}/></span><span><strong>{intent.summary}</strong><small>{intent.goal}. Expires {new Date(intent.expiresAt).toLocaleDateString()}</small></span><ChevronRight size={16}/></Link>):<div className="dashboard-empty"><Workflow size={32} strokeWidth={1.5}/><h3>One clear intention can open a door.</h3><p>Review a public intention, set an expiry and publish it with a separate wallet approval.</p><Link className="text-link" href="/intents">Shape your first intention<ArrowRight size={16}/></Link></div>}</section><section className="panel dashboard-section"><div className="panel-title"><h2>Latest activity</h2><Link className="text-link" href="/activity">See activity<ArrowUpRight size={15}/></Link></div>{state.audit.length?<div className="audit-list">{state.audit.slice(0,4).map(event=><article key={event.id}><span className="audit-dot"/><div><strong>{event.action.replaceAll('_',' ')}</strong><p>{event.detail}</p><small>{new Date(event.createdAt).toLocaleString()}</small></div><Tag good={['success','allowed'].includes(event.outcome)}>{event.outcome}</Tag></article>)}</div>:<div className="dashboard-empty"><ChartLine size={32} strokeWidth={1.5}/><h3>A quiet start.</h3><p>Actual account actions, permission checks and agent activity appear here. Agents run when you request a supported action.</p></div>}</section></div>
    <details className="advanced-overview panel"><summary>Connection status and advanced setup</summary><div className="integration-list">{Object.entries(state.integrations).map(([name,status])=><div className="integration-row" key={name}><span className="icon-box">{name==='ens'?<Fingerprint size={20}/>:name==='arkiv'?<Globe2 size={20}/>:name==='ai'?<Sparkles size={20}/>:<LockKeyhole size={20}/>}</span><div><strong>{name==='world'?'World human verification (future scope)':name==='ai'?'Agent model':name.toUpperCase()}</strong><small>{name==='world'&&status.status==='deferred'?'World human verification is not available in this demo. Protected release remains locked.':status.message}</small></div><Tag>{status.status==='ready'?'Configured':status.status==='deferred'?(name==='world'?'Future scope':'Paused'):status.status}</Tag></div>)}</div><Link className="text-link" href="/settings">Open settings and operation journal<ArrowRight size={16}/></Link></details>
  </>;
}
