/**
 * How background work (a CV, an application package) reaches the member when
 * it finishes, even if WhatsApp reconnected in the meantime.
 */
export interface CareerMessenger {
  connected(): boolean;
  sendText(chatJid: string, text: string): Promise<void>;
  sendDocument(chatJid: string, data: Buffer, fileName: string, mimetype: string, caption?: string): Promise<void>;
  sendImage?(chatJid: string, data: Buffer, caption?: string): Promise<void>;
}

let messenger: CareerMessenger | null = null;

export function setCareerMessenger(value: CareerMessenger): void {
  messenger = value;
}

export function careerMessenger(): CareerMessenger | null {
  return messenger;
}
