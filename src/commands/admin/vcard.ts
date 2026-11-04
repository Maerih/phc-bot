/** Contacts as vCard 3.0, for importing into a phone in one tap. */
function vcardEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, ' ');
}

/** One vCard per member. Exported for tests. */
export function vcards(people: Array<{ jid: string; name: string | null }>): string {
  const cards = people.map((person) => {
    const number = person.jid.split('@')[0]!.split(':')[0]!;
    const name = person.name?.trim() || `PHC member ${number.slice(-4)}`;
    return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${vcardEscape(name)}`, `N:;${vcardEscape(name)};;;`, `TEL;type=CELL;waid=${number}:+${number}`, 'NOTE:Public Health Colosseum', 'END:VCARD'].join('\r\n');
  });
  return `${cards.join('\r\n')}\r\n`;
}
