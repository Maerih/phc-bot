import { describe, expect, it } from 'vitest';
import { vcards } from './vcard.js';

describe('vcards', () => {
  it('builds one escaped card per member, with a fallback name', () => {
    const text = vcards([{ jid: '254711000111:3@s.whatsapp.net', name: 'Doe; Jane, MPH' }, { jid: '254722000222@s.whatsapp.net', name: null }]);
    expect(text.match(/BEGIN:VCARD/g)).toHaveLength(2);
    expect(text).toContain('FN:Doe\\; Jane\\, MPH');
    expect(text).toContain('TEL;type=CELL;waid=254711000111:+254711000111');
    expect(text).toContain('FN:PHC member 0222');
    expect(text.endsWith('END:VCARD\r\n')).toBe(true);
  });
});
