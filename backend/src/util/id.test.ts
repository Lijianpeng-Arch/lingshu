import { describe, it, expect } from 'vitest';
import { newId } from './id.js';

describe('newId', () => {
  it('returns uuid v4 without prefix', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
  it('returns uuid v4 with prefix', () => {
    const id = newId('env');
    expect(id).toMatch(/^env-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
  it('returns unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('msg')));
    expect(ids.size).toBe(1000);
  });
});
