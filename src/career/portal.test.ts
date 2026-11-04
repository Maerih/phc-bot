import { describe, expect, it } from 'vitest';
import { referenceIn } from './portal.js';

describe('referenceIn', () => {
  it('finds the code, not the word', () => {
    expect(referenceIn('Your application has been received. Application reference: KMR-2026-0457')).toBe('KMR-2026-0457');
    expect(referenceIn('Confirmation number #A12345')).toBe('A12345');
    expect(referenceIn('Thank you for your application. We will be in touch.')).toBeNull();
  });
});
