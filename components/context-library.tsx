'use client';

import Link from 'next/link';

import { useEffect, useRef, useState } from 'react';
import { Download, FileText, LockKeyhole, RefreshCw, Upload } from 'lucide-react';
import type { ContextDocument } from '@/packages/shared/src';
import { Button, Field, Tag, api, type Shared } from './workspace-features';
import styles from './context-library.module.css';

type DocumentDraft = Pick<ContextDocument, 'reviewedExcerpt' | 'allowAgentContext' | 'allowOriginalShare'>;
const maxBytes = 1024 * 1024;

function documentDraft(document: ContextDocument): DocumentDraft {
  return { reviewedExcerpt: document.reviewedExcerpt, allowAgentContext: document.allowAgentContext, allowOriginalShare: document.allowOriginalShare };
}

function fileMime(file: File): ContextDocument['mimeType'] {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'pdf' && (!file.type || file.type === 'application/pdf')) return 'application/pdf';
  if (extension === 'txt' && (!file.type || file.type === 'text/plain')) return 'text/plain';
  if ((extension === 'md' || extension === 'markdown') && (!file.type || file.type === 'text/plain' || file.type === 'text/markdown')) return 'text/markdown';
  throw new Error('Choose a PDF, TXT or Markdown file. Other file types are not supported.');
}

async function encodeFile(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function ContextLibrary(props: Shared) {
  return <AccountContextLibrary key={props.state.user.id} {...props} />;
}

function AccountContextLibrary({ state, run, busy }: Shared) {
  const [documents, setDocuments] = useState<ContextDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void api<ContextDocument[]>('context/files').then(result => {
      if (alive.current) { setDocuments(result); setLoaded(true); }
    }).catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : 'Your private files could not be loaded.'); })
      .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, []);

  async function refresh() {
    const result = await api<ContextDocument[]>('context/files');
    if (alive.current) { setDocuments(result); setLoaded(true); }
  }

  async function perform(task: () => Promise<unknown>, message?: string) {
    if (pending || busy) return;
    setPending(true);
    setError('');
    try {
      await run(async () => {
        try { await task(); }
        catch (cause) {
          if (alive.current) setError(cause instanceof Error ? cause.message : 'This file action could not be completed.');
          throw cause;
        }
      }, message);
    } finally { if (alive.current) setPending(false); }
  }

  const disabled = busy || pending || loading;
  return <section className={`panel form-panel ${styles.library}`} aria-labelledby="private-context-heading">
    <div className={styles.intro}><FileText size={27} /><div><span className="section-note">Your private context library</span><h2 id="private-context-heading">A resume, with boundaries you review.</h2><p>Upload a resume or supporting file, then write or review a short excerpt your agent may use. Files and excerpts are stored privately with encryption. Original files never enter model context, ENS or Arkiv.</p></div></div>
    <div className={styles.toolbar}><Tag><LockKeyhole size={13} /> Private by default</Tag><small>{loaded ? `${documents.length} of 5 files` : 'Up to 5 files'}</small><Button kind="secondary" disabled={disabled} onClick={() => void perform(refresh)}><RefreshCw size={14} />Refresh files</Button></div>
    {error && <p className={styles.error} role="alert">{error} Your selected file and unsaved excerpt changes are preserved.</p>}
    <fieldset className={styles.fieldset} disabled={disabled}>
      <form className={styles.upload} onSubmit={event => { event.preventDefault(); void perform(async () => {
        if (!file) throw new Error('Choose a file first.');
        if (file.size === 0 || file.size > maxBytes) throw new Error('The file must contain data and be no larger than 1 MiB.');
        if (documents.length >= 5) throw new Error('You can keep up to five files. Delete a file before uploading another.');
        const mimeType = fileMime(file);
        const contentBase64 = await encodeFile(file);
        if (!alive.current) return;
        const saved = await api<ContextDocument>('context/files', { name: file.name, mimeType, contentBase64 });
        if (!alive.current) return;
        setDocuments(current => [...current.filter(item => item.id !== saved.id), saved]);
        setFile(null);
        setInputKey(current => current + 1);
      }, 'Your file has been saved privately. Review an excerpt before allowing agent use.'); }}>
        <Field label="Resume or supporting file" hint="PDF, TXT or Markdown. Maximum 1 MiB each, up to five files. PDF extraction covers the first five pages and does not perform OCR."><input key={inputKey} className={styles.fileInput} type="file" accept=".pdf,.txt,.md,.markdown,application/pdf,text/plain,text/markdown" onChange={event => setFile(event.target.files?.[0] || null)} /></Field>
        <Button kind="secondary" type="submit" disabled={!file || !loaded || documents.length >= 5}><Upload size={15} />Upload private file</Button>
      </form>
    </fieldset>
    {loading ? <p role="status">Loading your private files...</p> : loaded && !documents.length ? <p className={styles.empty}>No files yet. Add a resume or write your profile first. Uploading a file does not give your agent permission to read or share it.</p> : null}
    <div className={styles.documents}>{documents.map(document => <DocumentCard key={document.id} document={document} state={state} busy={disabled} perform={perform} onSaved={saved => setDocuments(current => current.map(item => item.id === saved.id ? saved : item))} onDeleted={() => setDocuments(current => current.filter(item => item.id !== document.id))} />)}</div>
  </section>;
}

function DocumentCard({ document, state, busy, perform, onSaved, onDeleted }: {
  document: ContextDocument; state: Shared['state']; busy: boolean;
  perform: (task: () => Promise<unknown>, message?: string) => Promise<void>;
  onSaved: (document: ContextDocument) => void; onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<DocumentDraft | null>(null);
  const [baseVersion, setBaseVersion] = useState(document.version);
  const [deleteReview, setDeleteReview] = useState(false);
  const [proposalId, setProposalId] = useState('');
  const [protectedShare, setProtectedShare] = useState<{ url: string; expiresAt: string; version: number; proposalId: string } | null>(null);
  const form = draft || documentDraft(document);
  const conflict = draft !== null && baseVersion !== document.version;
  const canEnableContext = state.profile.aiConsent && !!state.agent?.policy.allowedFields.includes('documentContext') && !!form.reviewedExcerpt.trim();
  const worldPaused = state.integrations.world.status === 'deferred';
  const room = state.rooms.find(item => item.proposalId === proposalId);
  const savedOnly = draft === null;

  function update<Key extends keyof DocumentDraft>(key: Key, value: DocumentDraft[Key]) {
    if (!draft) setBaseVersion(document.version);
    setDraft({ ...form, [key]: value });
  }

  return <article className={styles.document}>
    <header><div><h3>{document.name}</h3><small>{Math.ceil(document.size / 1024)} KiB. Version {document.version}. Updated {new Date(document.updatedAt).toLocaleString()}.</small></div><Tag>{draft ? 'Unsaved changes' : document.allowAgentContext ? 'Excerpt approved' : 'Agent use off'}</Tag></header>
    <fieldset className={styles.fieldset} disabled={busy}>
      <div className={styles.toolbar}><a className="text-link" href={`/api/context/files/${encodeURIComponent(document.id)}/download`} download><Download size={14} />Download my original</a></div>
      {conflict && <div className={styles.notice} role="status"><strong>This file changed in another session.</strong><p>Your draft is preserved. Review the current saved excerpt before saving again.</p><details><summary>Current saved excerpt and permissions</summary><p className={styles.extracted}>{document.reviewedExcerpt || 'No approved excerpt.'}</p><p>Agent use: {document.allowAgentContext ? 'On' : 'Off'}. Original sharing: {document.allowOriginalShare ? 'On' : 'Off'}.</p></details><div className={styles.toolbar}><Button kind="secondary" onClick={() => { setDraft(null); setBaseVersion(document.version); }}>Use saved values</Button><Button kind="secondary" onClick={() => setBaseVersion(document.version)}>I reviewed the changes. Keep my draft.</Button></div></div>}
      <details><summary>{document.extractionStatus === 'ready' ? 'Review extracted text' : 'Extraction needs your review'}</summary>
        {document.extractionStatus === 'ready' ? <><p className={styles.extracted}>{document.extractedText}</p><Button kind="secondary" onClick={() => update('reviewedExcerpt', document.extractedText.slice(0, 1200))}>Copy first 1,200 characters into my draft</Button><p className="small-copy">Read and edit the excerpt before approving it. Text inside a file is context, never an instruction to expand permissions.</p></> : <p>{document.extractionStatus === 'no-text' ? 'No readable text was found. Scanned PDFs need a manually written excerpt because OCR is not available.' : 'Text extraction did not complete. You can still write a reviewed excerpt manually or replace this file.'}</p>}
      </details>
      <form onSubmit={event => { event.preventDefault(); void perform(async () => {
        if (conflict) throw new Error('Review the newer saved file version before saving your excerpt.');
        const saved = await api<ContextDocument>(`context/files/${encodeURIComponent(document.id)}/update`, { expectedVersion: draft ? baseVersion : document.version, ...form });
        onSaved(saved);
        setDraft(null);
        setBaseVersion(saved.version);
      }, 'Your reviewed excerpt and file permissions have been saved.'); }}>
        <Field label={`Reviewed agent excerpt for ${document.name}`} hint={`${form.reviewedExcerpt.length} of 1,200 characters. Include only information you want a permitted agent to use or exchange.`}><textarea rows={5} maxLength={1200} value={form.reviewedExcerpt} onChange={event => { update('reviewedExcerpt', event.target.value); }} /></Field>
        <label className="checkline"><input type="checkbox" checked={form.allowAgentContext} disabled={!form.allowAgentContext && !canEnableContext} onChange={event => update('allowAgentContext', event.target.checked)} /><span>Allow my agent to use and exchange this reviewed excerpt.</span></label>
        <p className="small-copy">A nonempty reviewed excerpt, saved profile AI consent and a current ENS policy allowing document context are required. The server checks live permission for each use. <Link className="text-link" href="/agent">Manage agent policy</Link></p>
        <label className="checkline"><input type="checkbox" checked={form.allowOriginalShare} onChange={event => update('allowOriginalShare', event.target.checked)} /><span>Allow me to explicitly share this original file inside an authorized introduction room.</span></label>
        <p className="small-copy">This permission alone does not share a file. Sharing requires a separate action below and fresh protected room checks.</p>
        <div className={styles.toolbar}>{draft && <Button kind="secondary" onClick={() => { setDraft(null); setBaseVersion(document.version); }}>Discard excerpt draft</Button>}<Button kind="secondary" type="submit" disabled={!draft || conflict}>Save excerpt and permissions</Button></div>
      </form>
      <div className={styles.originalShare}><h4>Share the original in a protected room</h4><p className="small-copy">Original files require your explicit permission, an existing introduction room, both current consents, current ENS authority and fresh World validation. They are never sent to an agent model.</p>
        {worldPaused ? <p className={styles.notice}>World approval is paused. Original file sharing remains locked.</p> : !state.rooms.length ? <p className={styles.notice}>No protected introduction room is open. Complete the mutual approval and World steps before sharing a file.</p> : <><Field label={`Protected room for ${document.name}`}><select value={proposalId} onChange={event => setProposalId(event.target.value)}><option value="">Choose an existing room</option>{state.rooms.map(item => <option key={item.id} value={item.proposalId}>{item.title}</option>)}</select></Field><Button kind="secondary" disabled={!savedOnly || !document.allowOriginalShare || !room} onClick={() => void perform(async () => {
          const result = await api<{ url: string; expiresAt: string; version: number; proposalId: string }>(`context/files/${encodeURIComponent(document.id)}/share`, { proposalId, expectedVersion: document.version });
          setProtectedShare({ ...result, url: new URL(result.url, window.location.origin).href });
        }, 'A protected file link has been created for the selected room.')}><Upload size={14} />Create protected original file link</Button>{!savedOnly && <p className="small-copy">Save or discard your excerpt and permission changes before sharing the saved file.</p>}</>}
        {protectedShare && protectedShare.version === document.version && protectedShare.proposalId === proposalId && document.allowOriginalShare && !worldPaused && <div className={styles.notice}><Field label="Protected file link"><input readOnly value={protectedShare.url} onFocus={event => event.target.select()} /></Field><p>Copy this link into the selected room when you are ready. No message has been sent. Only that room counterpart can use it after fresh server permission checks. It expires {new Date(protectedShare.expiresAt).toLocaleString()}.</p></div>}
      </div>
      <div className={styles.toolbar}>{deleteReview ? <><p className={styles.danger}>Delete this private file and its reviewed excerpt? Previously downloaded copies cannot be recalled.</p><Button kind="danger" onClick={() => void perform(async () => { await api(`context/files/${encodeURIComponent(document.id)}/delete`, { expectedVersion: document.version }); onDeleted(); }, 'The private file and reviewed excerpt have been deleted.')}>Delete this file</Button><Button kind="secondary" onClick={() => setDeleteReview(false)}>Keep file</Button></> : <button type="button" className="text-link danger-text" onClick={() => setDeleteReview(true)}>Review file deletion</button>}</div>
    </fieldset>
  </article>;
}
