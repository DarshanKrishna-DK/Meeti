import { z } from 'zod';
import { IntentSemanticsSchema } from '../matching/src/semantics';
export const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const hexSchema = z.string().regex(/^0x[0-9a-fA-F]+$/).max(30000);
export const goalSchema = z.enum(['cofounder', 'collaborator', 'mentor', 'teammate']);
export const tagsSchema = z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).min(1).max(8).refine(x => new Set(x).size === x.length);
export const profileSchema = z.object({
  displayName: z.string().trim().min(1).max(100), headline: z.string().max(200), bio: z.string().max(1500),
  seeking: z.string().max(1500), offering: z.string().max(1500), tags: z.array(z.string().max(32)).max(8),
  contact: z.string().max(300), employer: z.string().max(200),
  roles: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
  skills: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  interests: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
  goals: z.array(z.string().trim().min(1).max(160)).max(6).optional(),
  location: z.string().trim().max(160).optional(),
  timezone: z.string().trim().max(80).refine(value => { if (!value) return true; try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Choose a valid timezone, such as Asia/Kolkata.').optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  availability: z.string().trim().max(600).optional(),
  collaborationMode: z.enum(['unspecified', 'remote', 'hybrid', 'in-person']).optional(),
  contextSharing: z.enum(['private-agent', 'authorized-counterpart', 'ask-first']).optional(),
  publicFields: z.array(z.enum(['displayName', 'headline', 'bio', 'seeking', 'offering', 'tags', 'socialLinks'])).max(7).refine(values => new Set(values).size === values.length), aiConsent: z.boolean(),
  socialLinks: z.array(z.object({ label: z.string().trim().min(1).max(60), url: z.string().trim().max(500).url().refine(value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } }, 'Use an HTTPS link without embedded credentials.') }).strict()).max(6).refine(values => new Set(values.map(value => value.url)).size === values.length, 'Remove duplicate links.').optional(),
}).strict();
export const agentSchema = z.object({
  ensName: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+){1,6}\.eth$/).max(253),
  delegate: addressSchema, persona: z.string().max(1000), resolverAddress: addressSchema.optional().or(z.literal('')),
  policyUri: z.string().url().startsWith('https://').max(2048).optional().or(z.literal('')),
  policy: z.object({ purpose: goalSchema,
    allowedFields: z.array(z.enum(['displayName', 'headline', 'bio', 'seeking', 'offering', 'tags', 'contact', 'employer', 'socialLinks', 'documentContext', 'profileContext'])).max(11).refine(values => new Set(values).size === values.length),
    allowedActions: z.array(z.enum(['discover', 'publish', 'evaluate', 'negotiate', 'introduce', 'message'])).max(6),
    expiresAt: z.string().datetime().refine(x => Date.parse(x) > Date.now() && Date.parse(x) <= Date.now() + 30 * 86400000), paused: z.boolean(),
  }).strict(),
}).strict();
export const intentInputSchema = z.object({ id: z.string().uuid().optional(), expectedVersion: z.number().int().positive().safe().optional(), goal: goalSchema, summary: z.string().trim().min(10).max(1000),
  tags: tagsSchema, expiresAt: z.string().datetime().refine(x => Date.parse(x) > Date.now() + 60000 && Date.parse(x) <= Date.now() + 30 * 86400000),
  publicApproved: z.literal(true), demoOrigin: z.boolean().default(false),
  semantics: IntentSemanticsSchema.optional(),
}).strict();
