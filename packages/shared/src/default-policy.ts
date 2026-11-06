import type { Action } from './index';

export const DEFAULT_POLICY_ACTIONS: readonly Action[] = ['discover', 'publish', 'evaluate', 'negotiate', 'introduce', 'message'];
export const DEFAULT_POLICY_FIELDS: readonly string[] = ['headline', 'tags', 'offering', 'seeking'];
export const DEFAULT_POLICY_DAYS = 7;
