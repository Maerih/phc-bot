/**
 * Keep the Signal library's session dumps out of the log.
 *
 * libsignal (inside Baileys) prints whole session records with console.info
 * whenever it opens or closes a session — routine on every reconnect. Those
 * records hold private key material, which has no business in a log file, and
 * the noise buries the QR code in the terminal. Only those calls are dropped;
 * its errors, such as failed decryption, still come through.
 */
const NOISY_PREFIXES = [
  'Closing session:',
  'Opening session:',
  'Removing old closed session:',
  'Session already closed',
  'Session already open',
  'Closing open session in favor of incoming prekey bundle',
];

function isLibsignalNoise(args: unknown[]): boolean {
  const first = args[0];
  return typeof first === 'string' && NOISY_PREFIXES.some((prefix) => first.startsWith(prefix));
}

export function quietLibsignal(): void {
  for (const method of ['info', 'log', 'warn'] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (!isLibsignalNoise(args)) original(...args);
    };
  }
}
