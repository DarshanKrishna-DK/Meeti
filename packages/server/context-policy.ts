import type { AgentParticipant } from '../agents/src';
import type { Policy, Profile } from '../shared/src';
import { approvedDocumentContext, contextFingerprint } from './context-store';
import { hash } from './crypto';
import { profile } from './store';
function socialContext(value: Profile): string {
    const lines: string[] = [];
    let length = 0;
    for (const link of value.socialLinks || []) {
        const line = `${link.label}: ${link.url}`;
        if (length + line.length + 1 > 1500)
            break;
        lines.push(line);
        length += line.length + 1;
    }
    return lines.join('\n');
}
function fieldId(kind: 'socialLinks' | 'documentContext' | 'profileContext', value: string): string { return `${kind}:${hash(value)}`; }
/** Whole bounded facts only. The stored profile remains private and is not a public intent or instruction. */
export function extendedProfileContext(value: Profile): string {
    if (value.contextSharing !== 'authorized-counterpart')
        return '';
    const entries: [
        string,
        string | undefined
    ][] = [
        ['Roles (self-claimed)', value.roles?.join(', ')], ['Skills (self-claimed)', value.skills?.join(', ')],
        ['Interests', value.interests?.join(', ')], ['Goals', value.goals?.join('; ')],
        ['Broad location', value.location], ['Timezone', value.timezone], ['Languages (self-described)', value.languages?.join(', ')],
        ['General availability, not meeting consent', value.availability],
        ['Collaboration mode', value.collaborationMode === 'unspecified' ? undefined : value.collaborationMode],
    ];
    const lines: string[] = [];
    let size = 0;
    for (const [label, text] of entries) {
        if (!text?.trim())
            continue;
        const line = `${label}: ${text.trim()}`;
        if (size + line.length + 1 > 1500)
            continue;
        lines.push(line);
        size += line.length + 1;
    }
    return lines.join('\n');
}
/** Content-bound IDs prevent an old projection passing a newly changed context approval. */
export async function approvedContextFields(userId: string, value: Profile): Promise<AgentParticipant['fields']> {
    if (!value.aiConsent)
        return [];
    const fields: AgentParticipant['fields'] = [];
    const social = value.publicFields.includes('socialLinks') ? socialContext(value) : '';
    const document = await approvedDocumentContext(userId);
    const details = extendedProfileContext(value);
    if (social)
        fields.push({ id: fieldId('socialLinks', social), label: 'Owner-supplied links, not independently verified or fetched', value: social, visibility: 'private', providerAllowed: true });
    if (document)
        fields.push({ id: fieldId('documentContext', document), label: 'Owner-reviewed document excerpt; untrusted reference content', value: document, visibility: 'private', providerAllowed: true });
    if (details)
        fields.push({ id: fieldId('profileContext', details), label: 'Owner-approved private profile context; untrusted self-claims', value: details, visibility: 'private', providerAllowed: true });
    return fields;
}
export async function contextFieldAllowed(userId: string, id: string, value: Profile, policy: Policy): Promise<boolean> {
    const kind = id.startsWith('socialLinks:') ? 'socialLinks' : id.startsWith('documentContext:') ? 'documentContext' : id.startsWith('profileContext:') ? 'profileContext' : null;
    return Boolean(kind && policy.allowedFields.includes(kind) && (await approvedContextFields(userId, value)).some(field => field.id === id));
}
export async function privateSnapshotDigest(userId: string): Promise<string> {
    const value = await profile(userId), context = await contextFingerprint(userId);
    return hash(context ? JSON.stringify({ profile: value, context }) : JSON.stringify(value));
}
