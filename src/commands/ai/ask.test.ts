import { describe, expect, it } from 'vitest';
import { needsCurrentInformation, opportunitySearchText } from './ask.js';

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

describe('.ask and current events', () => {
  it('looks things up when the question is about now', () => {
    expect(needsCurrentInformation('what is the current situation of public health in Kenya')).toBe(true);
    expect(needsCurrentInformation('latest cholera outbreak news')).toBe(true);
    expect(needsCurrentInformation('what happened in 2026 with the health budget')).toBe(true);
  });

  it('answers timeless questions directly', () => {
    expect(needsCurrentInformation('explain confounding in simple terms')).toBe(false);
    expect(needsCurrentInformation('what is the capital of Australia')).toBe(false);
  });
});
