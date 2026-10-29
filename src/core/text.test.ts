import { describe, expect, it } from 'vitest';
import { canonical, collapseWhitespace, stripHtml, tokens, truncate } from './text.js';

describe('stripHtml', () => {
  it('removes ordinary tags', () => {
    expect(stripHtml('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
  });

  it('removes script and style bodies entirely', () => {
    expect(stripHtml('<p>Safe</p><script>alert(1)</script>')).toBe('Safe');
    expect(stripHtml('<style>.a{color:red}</style><p>Safe</p>')).toBe('Safe');
  });

  it('decodes entities', () => {
    expect(stripHtml('<p>Caf&eacute; &amp; co &ndash; 5&nbsp;days</p>')).toBe('Café & co – 5 days');
  });

  it('turns list items into bullets and block tags into line breaks', () => {
    expect(stripHtml('<ul><li>One</li><li>Two</li></ul>')).toBe('• One\n• Two');
  });

  it('strips entity-encoded html rather than displaying it as text', () => {
    // Regression: one source delivers HTML that is itself entity-encoded, and
    // the markup was rendered verbatim to members.
    const encoded = '&lt;div class="intro"&gt;&lt;h3&gt;&lt;strong&gt;About Us&lt;/strong&gt;&lt;/h3&gt;&lt;p&gt;We hire.&lt;/p&gt;&lt;/div&gt;';
    const result = stripHtml(encoded);
    expect(result).toContain('About Us');
    expect(result).toContain('We hire.');
    expect(result).not.toContain('<');
    expect(result).not.toContain('div');
  });

  it('keeps ordinary text containing comparison operators', () => {
    // The re-strip pass must not treat "< b >" as a tag.
    expect(stripHtml('<p>Accepts a &lt; b &gt; c ranges</p>')).toBe('Accepts a < b > c ranges');
  });

  it('handles empty and null input', () => {
    expect(stripHtml('')).toBe('');
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });

  it('collapses excessive whitespace', () => {
    expect(stripHtml('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 20)).toBe('short');
  });

  it('cuts on a word boundary and marks the cut', () => {
    const result = truncate('the quick brown fox jumps over', 20);
    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(21);
  });
});

describe('canonical and tokens', () => {
  it('folds case, accents and punctuation', () => {
    expect(canonical('Café—Health, Data!')).toBe('cafe health data');
  });

  it('splits into distinct tokens and drops single characters', () => {
    expect(tokens('Public Health a Public')).toEqual(['public', 'health']);
  });

  it('returns an empty array for empty input', () => {
    expect(tokens('')).toEqual([]);
    expect(tokens(null)).toEqual([]);
  });
});

describe('collapseWhitespace', () => {
  it('keeps paragraph breaks but removes runs', () => {
    expect(collapseWhitespace('a   b\n\n\n\nc')).toBe('a b\n\nc');
  });
});
