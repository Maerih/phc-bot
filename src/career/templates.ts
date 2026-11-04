/**
 * CV and cover-letter templates: HTML for PDF, and the same structure as a
 * Word document. Single text layer, real headings and no tables for the
 * modern and classic layouts, so applicant-tracking systems read them cleanly.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TabStopPosition,
  TabStopType,
  TextRun,
} from 'docx';
import type { CoverLetter, CvContent } from './cv.js';

export type TemplateName = 'modern' | 'classic' | 'compact';
export const TEMPLATES: Record<TemplateName, { label: string; description: string; accent: string }> = {
  modern: { label: 'Modern', description: 'clean single column with a teal accent — the best all-rounder for online applications', accent: '#0B6E4F' },
  classic: { label: 'Classic', description: 'traditional serif layout — suits government, academic and research posts', accent: '#1F2937' },
  compact: { label: 'Compact', description: 'two columns with a skills sidebar — fits more on one page', accent: '#1D4E89' },
};

export function parseTemplate(value: string | null | undefined): TemplateName {
  const key = (value ?? '').toLowerCase();
  return key === 'classic' || key === 'compact' ? key : 'modern';
}

function esc(text: string | undefined | null): string {
  return (text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── HTML (PDF) ──────────────────────────────────────────────────────────────

function section(title: string, body: string): string {
  return body.trim() ? `<section><h2>${esc(title)}</h2>${body}</section>` : '';
}

function bodySections(cv: CvContent, includeSidebarParts: boolean): string {
  const experience = cv.experience
    .map(
      (item) => `<div class="item"><div class="row"><span class="role">${esc(item.role)}</span><span class="dates">${esc(item.dates)}</span></div>
<div class="org">${esc(item.organization)}${item.location ? ` · ${esc(item.location)}` : ''}</div>
<ul>${item.bullets.map((bullet) => `<li>${esc(bullet)}</li>`).join('')}</ul></div>`,
    )
    .join('');
  const education = cv.education
    .map(
      (item) => `<div class="item"><div class="row"><span class="role">${esc(item.qualification)}</span><span class="dates">${esc(item.dates)}</span></div>
<div class="org">${esc(item.institution)}</div>${item.details ? `<p class="details">${esc(item.details)}</p>` : ''}</div>`,
    )
    .join('');
  const projects = cv.projects.map((item) => `<li><strong>${esc(item.name)}</strong>${item.description ? ` — ${esc(item.description)}` : ''}</li>`).join('');
  const parts = [
    section('Profile', cv.summary ? `<p>${esc(cv.summary)}</p>` : ''),
    section('Experience', experience),
    section('Education', education),
    section('Projects', projects ? `<ul>${projects}</ul>` : ''),
    section('Achievements', cv.achievements.length ? `<ul>${cv.achievements.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''),
  ];
  if (includeSidebarParts) parts.push(...sidebarSections(cv));
  return parts.join('');
}

function sidebarSections(cv: CvContent): string[] {
  return [
    section('Skills', cv.skills.map((group) => `<p class="skills"><strong>${esc(group.group)}:</strong> ${group.items.map(esc).join(', ')}</p>`).join('')),
    section('Certifications', cv.certifications.length ? `<ul>${cv.certifications.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : ''),
    section('Languages', cv.languages.length ? `<p>${cv.languages.map(esc).join(', ')}</p>` : ''),
    section('Referees', cv.referees.map((ref) => `<p class="ref"><strong>${esc(ref.name)}</strong>${ref.detail ? `<br>${esc(ref.detail)}` : ''}</p>`).join('')),
  ];
}

const BASE_CSS = `*{box-sizing:border-box}body{margin:0;color:#1f2933;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{padding:18mm 17mm}h1{margin:0;line-height:1.1}h2{font-size:10.5pt;letter-spacing:.08em;text-transform:uppercase;margin:16px 0 6px}
p{margin:0 0 6px;line-height:1.45}ul{margin:4px 0 0 0;padding-left:16px}li{margin:0 0 3px;line-height:1.4}
.item{margin-bottom:10px;break-inside:avoid}.row{display:flex;justify-content:space-between;gap:12px}.role{font-weight:700}
.dates{color:#52606d;white-space:nowrap;font-size:9.5pt}.org{color:#3e4c59;font-style:italic;font-size:10pt}.details{font-size:10pt;color:#3e4c59}
.skills{margin-bottom:4px}.ref{font-size:10pt}.contact{color:#52606d;font-size:9.5pt;margin-top:6px}`;

export function cvHtml(cv: CvContent, template: TemplateName): string {
  const accent = TEMPLATES[template].accent;
  const contact = cv.contact.map(esc).join(' &nbsp;·&nbsp; ');
  if (template === 'compact') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
body{font-family:'Liberation Sans',Arial,Helvetica,sans-serif;font-size:10pt}
.wrap{display:flex;min-height:297mm}.side{width:34%;background:#eef3f9;padding:16mm 8mm 14mm 12mm}.main{width:66%;padding:16mm 13mm 14mm 9mm}
h1{font-size:20pt;color:${accent}}.headline{color:#3e4c59;margin:4px 0 10px;font-weight:600}
h2{color:${accent};border-bottom:1.5px solid ${accent};padding-bottom:2px}.side .contact p{margin:0 0 4px;font-size:9.5pt;word-break:break-word}
</style></head><body><div class="wrap"><aside class="side"><h1>${esc(cv.name)}</h1><div class="headline">${esc(cv.headline)}</div>
<div class="contact">${cv.contact.map((item) => `<p>${esc(item)}</p>`).join('')}</div>${sidebarSections(cv).join('')}</aside>
<main class="main">${bodySections(cv, false)}</main></div></body></html>`;
  }
  if (template === 'classic') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
body{font-family:'Liberation Serif','Times New Roman',Georgia,serif;font-size:11pt}header{text-align:center;border-bottom:1px solid #9aa5b1;padding-bottom:10px}
h1{font-size:22pt;letter-spacing:.04em}.headline{font-style:italic;margin-top:4px}h2{border-bottom:.8px solid #9aa5b1;padding-bottom:2px;color:${accent}}
</style></head><body><div class="page"><header><h1>${esc(cv.name)}</h1><div class="headline">${esc(cv.headline)}</div><div class="contact">${contact}</div></header>
${bodySections(cv, true)}</div></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
body{font-family:'Liberation Sans',Arial,Helvetica,sans-serif;font-size:10.5pt}header{border-left:6px solid ${accent};padding-left:12px;margin-bottom:6px}
h1{font-size:24pt;color:#111827}.headline{color:${accent};font-weight:700;margin-top:3px;font-size:11.5pt}
h2{color:${accent};display:flex;align-items:center;gap:8px}h2::after{content:'';flex:1;height:1.2px;background:${accent};opacity:.35}
</style></head><body><div class="page"><header><h1>${esc(cv.name)}</h1><div class="headline">${esc(cv.headline)}</div><div class="contact">${contact}</div></header>
${bodySections(cv, true)}</div></body></html>`;
}

export function letterHtml(letter: CoverLetter, sender: { name: string; contact: string[] }, recipient: { organization: string | null; position: string }, date: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}
body{font-family:'Liberation Sans',Arial,sans-serif;font-size:11pt}.page{padding:22mm 22mm}h1{font-size:18pt;color:#0B6E4F}
.meta{margin:18px 0}.meta p{margin:0 0 2px}p.body{margin:0 0 12px;line-height:1.55;text-align:justify}</style></head>
<body><div class="page"><h1>${esc(sender.name)}</h1><div class="contact">${sender.contact.map(esc).join(' &nbsp;·&nbsp; ')}</div>
<div class="meta"><p>${esc(date)}</p>${recipient.organization ? `<p>${esc(recipient.organization)}</p>` : ''}<p><strong>Re: ${esc(recipient.position)}</strong></p></div>
<p class="body">${esc(letter.greeting)}</p>${letter.paragraphs.map((paragraph) => `<p class="body">${esc(paragraph)}</p>`).join('')}
<p class="body">${esc(letter.closing)}<br><br>${esc(sender.name)}</p></div></body></html>`;
}

// ── Word ────────────────────────────────────────────────────────────────────

function docHeading(text: string, color: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 240, after: 80 },
    border: { bottom: { color, space: 2, style: BorderStyle.SINGLE, size: 6 } },
    children: [new TextRun({ text: text.toUpperCase(), bold: true, color: color.replace('#', ''), size: 21 })],
  });
}

export async function cvDocx(cv: CvContent, template: TemplateName): Promise<Buffer> {
  const accent = TEMPLATES[template].accent;
  const font = template === 'classic' ? 'Times New Roman' : 'Calibri';
  const children: Paragraph[] = [
    new Paragraph({ alignment: template === 'classic' ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text: cv.name, bold: true, size: 40 })] }),
    new Paragraph({ alignment: template === 'classic' ? AlignmentType.CENTER : AlignmentType.LEFT, children: [new TextRun({ text: cv.headline, color: accent.replace('#', ''), bold: true, size: 23 })] }),
    new Paragraph({ alignment: template === 'classic' ? AlignmentType.CENTER : AlignmentType.LEFT, spacing: { after: 120 }, children: [new TextRun({ text: cv.contact.join('  ·  '), color: '52606D', size: 19 })] }),
  ];
  const add = (title: string, paragraphs: Paragraph[]): void => {
    if (paragraphs.length === 0) return;
    children.push(docHeading(title, accent), ...paragraphs);
  };
  add('Profile', cv.summary ? [new Paragraph({ children: [new TextRun(cv.summary)] })] : []);
  const roleLine = (left: string, right: string | undefined): Paragraph =>
    new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
      spacing: { before: 120 },
      children: [new TextRun({ text: left, bold: true }), ...(right ? [new TextRun({ text: `\t${right}`, color: '52606D' })] : [])],
    });
  add(
    'Experience',
    cv.experience.flatMap((item) => [
      roleLine(item.role, item.dates),
      new Paragraph({ children: [new TextRun({ text: `${item.organization}${item.location ? ` · ${item.location}` : ''}`, italics: true, color: '3E4C59' })] }),
      ...item.bullets.map((bullet) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(bullet)] })),
    ]),
  );
  add(
    'Education',
    cv.education.flatMap((item) => [
      roleLine(item.qualification, item.dates),
      new Paragraph({ children: [new TextRun({ text: item.institution, italics: true, color: '3E4C59' })] }),
      ...(item.details ? [new Paragraph({ children: [new TextRun(item.details)] })] : []),
    ]),
  );
  add('Skills', cv.skills.map((group) => new Paragraph({ children: [new TextRun({ text: `${group.group}: `, bold: true }), new TextRun(group.items.join(', '))] })));
  add('Certifications', cv.certifications.map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(item)] })));
  add('Projects', cv.projects.map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: item.name, bold: true }), ...(item.description ? [new TextRun(` — ${item.description}`)] : [])] })));
  add('Achievements', cv.achievements.map((item) => new Paragraph({ bullet: { level: 0 }, children: [new TextRun(item)] })));
  add('Languages', cv.languages.length ? [new Paragraph({ children: [new TextRun(cv.languages.join(', '))] })] : []);
  add('Referees', cv.referees.map((ref) => new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: ref.name, bold: true }), ...(ref.detail ? [new TextRun(` — ${ref.detail}`)] : [])] })));

  const document = new Document({
    styles: { default: { document: { run: { font, size: 21 } } } },
    sections: [{ properties: { page: { margin: { top: 900, bottom: 900, left: 1000, right: 1000 } } }, children }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}

export async function letterDocx(letter: CoverLetter, sender: { name: string; contact: string[] }, recipient: { organization: string | null; position: string }, date: string): Promise<Buffer> {
  const document = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [
      {
        properties: { page: { margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } } },
        children: [
          new Paragraph({ children: [new TextRun({ text: sender.name, bold: true, size: 34, color: '0B6E4F' })] }),
          new Paragraph({ spacing: { after: 300 }, children: [new TextRun({ text: sender.contact.join('  ·  '), color: '52606D', size: 19 })] }),
          new Paragraph({ children: [new TextRun(date)] }),
          ...(recipient.organization ? [new Paragraph({ children: [new TextRun(recipient.organization)] })] : []),
          new Paragraph({ spacing: { after: 240 }, children: [new TextRun({ text: `Re: ${recipient.position}`, bold: true })] }),
          new Paragraph({ spacing: { after: 200 }, children: [new TextRun(letter.greeting)] }),
          ...letter.paragraphs.map((paragraph) => new Paragraph({ spacing: { after: 200 }, alignment: AlignmentType.JUSTIFIED, children: [new TextRun(paragraph)] })),
          new Paragraph({ spacing: { before: 120 }, children: [new TextRun(letter.closing)] }),
          new Paragraph({ spacing: { before: 400 }, children: [new TextRun(sender.name)] }),
        ],
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(document));
}
