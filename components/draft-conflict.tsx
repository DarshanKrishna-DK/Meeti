import { RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from './workspace-features';

export function DraftConflict({ name, saved, onUseSaved, onKeepDraft }: {
  name: string;
  saved: Record<string, unknown>;
  onUseSaved: () => void;
  onKeepDraft: () => void;
}) {
  return <section className="draft-conflict" role="status">
    <div className="conflict-heading"><ShieldCheck size={20} /><strong>Your saved {name} changed in another session.</strong></div>
    <p>Your unsaved draft is still here. Review the saved values before deciding which changes to keep.</p>
    <details><summary>Review the latest saved values</summary><dl>{Object.entries(saved).map(([field, value]) => <div key={field}><dt>{field.replaceAll(/([A-Z])/g, ' $1').toLowerCase()}</dt><dd>{Array.isArray(value) ? value.join(', ') || 'None selected' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value || 'Not set')}</dd></div>)}</dl></details>
    <div className="conflict-actions"><Button kind="secondary" onClick={onUseSaved}><RefreshCw size={15} />Use saved values</Button><Button kind="secondary" onClick={onKeepDraft}>I reviewed the changes. Keep my draft.</Button></div>
  </section>;
}
