/**
 * Text from documents members send: PDF and Word. Images (scanned CVs) are
 * not read — the member is asked for their details instead.
 */
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';

export async function extractDocumentText(bytes: Buffer, mime: string, fileName: string): Promise<string> {
  try {
    if (/pdf/i.test(mime) || /\.pdf$/i.test(fileName)) {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return (Array.isArray(text) ? text.join('\n') : text).replace(/[ \t]+/g, ' ').trim();
    }
    if (/officedocument|word/i.test(mime) || /\.docx$/i.test(fileName)) {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      return value.trim();
    }
  } catch {
    return '';
  }
  return '';
}
