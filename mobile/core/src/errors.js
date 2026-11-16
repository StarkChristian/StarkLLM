/**
 * Error type for everything a remote peer can cause. Callers drop the frame or the connection
 * on a ProtocolError; they never forward the offending input anywhere.
 */
export class ProtocolError extends Error {
  /**
   * @param {string} code short machine-readable code, e.g. "bad_frame"
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ProtocolError';
    /** @type {string} */
    this.code = code;
  }
}
