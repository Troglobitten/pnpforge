import { customAlphabet } from 'nanoid';

/** Same shape as server ids: 12 lowercase alphanumerics. */
export const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);
