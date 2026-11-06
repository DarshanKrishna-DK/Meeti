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
  publicFields: z.array(z.enum(['displayName', 'headline', 'bio', 'seeking', 'offering', 'tags'])).max(6), aiConsent: z.boolean(),
}).strict();
export const agentSchema = z.object({
  ensName: z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+){1,6}\.eth$/).max(253),
  delegate: addressSchema, persona: z.string().max(1000), resolverAddress: addressSchema.optional().or(z.literal('')),
  policyUri: z.string().url().startsWith('https://').max(2048).optional().or(z.literal('')),
  policy: z.object({ purpose: goalSchema,
    allowedFields: z.array(z.enum(['displayName', 'headline', 'bio', 'seeking', 'offering', 'tags', 'contact', 'employer'])).max(8),
    allowedActions: z.array(z.enum(['discover', 'publish', 'evaluate', 'negotiate', 'introduce', 'message'])).max(6),
    expiresAt: z.string().datetime().refine(x => Date.parse(x) > Date.now() && Date.parse(x) <= Date.now() + 30 * 86400000), paused: z.boolean(),
  }).strict(),
}).strict();
export const intentInputSchema = z.object({ id: z.string().uuid().optional(), goal: goalSchema, summary: z.string().trim().min(10).max(1000),
  tags: tagsSchema, expiresAt: z.string().datetime().refine(x => Date.parse(x) > Date.now() + 60000 && Date.parse(x) <= Date.now() + 30 * 86400000),
  publicApproved: z.literal(true), demoOrigin: z.boolean().default(false),
  semantics: IntentSemanticsSchema.optional(),
}).strict();
