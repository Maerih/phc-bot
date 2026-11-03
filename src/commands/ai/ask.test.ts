import { describe, expect, it } from 'vitest';
import { opportunitySearchText } from './ask.js';

describe('.ask routing', () => {
  it('turns opportunity requests into searches', () => {
    expect(opportunitySearchText('find me nutrition internships in Kisumu')).toBe('nutrition internships Kisumu');
    expect(opportunitySearchText('Any public health scholarships for masters?')).toBe('public health scholarships masters');
    expect(opportunitySearchText('community health jobs nairobi')).toBe('community health jobs nairobi');
  });

  it('leaves ordinary questions to the assistant', () => {
    expect(opportunitySearchText('what does an epidemiologist do')).toBeNull();
    expect(opportunitySearchText('explain confounding in simple terms')).toBeNull();
    expect(opportunitySearchText('who won the world cup in 2022')).toBeNull();
  });

  it('answers how-to questions about applications rather than searching', () => {
    expect(opportunitySearchText('how do I write a cover letter for a scholarship')).toBeNull();
    expect(opportunitySearchText('tips for a fellowship interview')).toBeNull();
  });
});
