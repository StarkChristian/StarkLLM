// The StarkLLM remote request protocol: what a phone is allowed to ask, and a strict parser.
//
// Rules:
//  * ONLY the types listed in REQUEST_TYPES exist. Everything else is refused before it reaches any
//    code that talks to the engine ("never forwarded").
//  * Parameters are validated against a closed schema: unknown fields, wrong types and oversized
//    values are refused. The engine only ever sees the validated copy, never the received object.
//  * Messages are JSON objects { id, type, params } -> { id, ok, result | error } with streaming
//    chunks { id, chunk } and { id, done }.
import { ProtocolError } from './errors.js';
import { fromUtf8, utf8 } from './bytes.js';
import { MAX_MESSAGE_BYTES } from './constants.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OPAQUE_RE = /^[\x21-\x7e]{1,128}$/; // printable ASCII, no spaces, ids handed out by the PC

/** @typedef {{ kind: 'string', min?: number, max: number, pattern?: RegExp, optional?: boolean }} StringSpec */
/** @typedef {{ kind: 'int', min: number, max: number, optional?: boolean }} IntSpec */
/** @typedef {{ kind: 'bool', optional?: boolean }} BoolSpec */
/** @typedef {{ kind: 'enum', values: readonly string[], optional?: boolean }} EnumSpec */
/** @typedef {StringSpec | IntSpec | BoolSpec | EnumSpec} FieldSpec */

const hex64 = { kind: 'string', min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ };
const uploadId = { kind: 'string', min: 1, max: 64, pattern: ID_RE };
const opaque = (optional = true) => ({ kind: 'string', min: 1, max: 128, pattern: OPAQUE_RE, optional });
const limit = (max = 100) => ({ kind: 'int', min: 1, max, optional: true });

/**
 * The allow-list. `permission` is what the paired device needs; `method` is the one engine adapter
 * method that serves the request (see ENGINE_METHODS); `stream` marks answers sent in chunks.
 */
export const REQUEST_TYPES = Object.freeze({
  'device.info': Object.freeze({ permission: 'read', method: null, stream: false, params: {} }),
  // Key rotation: inside an authenticated session the phone announces a new X25519 public key.
  // Answered by the host itself (device registry), never by the engine.
  'device.rotate_key': Object.freeze({
    permission: 'read',
    method: null,
    stream: false,
    params: { public_key: { kind: 'string', min: 43, max: 43, pattern: /^[A-Za-z0-9_-]{43}$/ } },
  }),
  'inbox.list': Object.freeze({
    permission: 'read',
    method: 'inboxList',
    stream: false,
    params: { limit: limit(), cursor: opaque(), unread_only: { kind: 'bool', optional: true } },
  }),
  'deadlines.list': Object.freeze({
    permission: 'read',
    method: 'deadlinesList',
    stream: false,
    params: { within_days: { kind: 'int', min: 1, max: 365, optional: true }, limit: limit() },
  }),
  'cases.list': Object.freeze({
    permission: 'read',
    method: 'casesList',
    stream: false,
    params: {
      limit: limit(),
      cursor: opaque(),
      status: { kind: 'enum', values: ['open', 'closed', 'all'], optional: true },
    },
  }),
  'workspaces.list': Object.freeze({
    permission: 'read',
    method: 'workspacesList',
    stream: false,
    params: { limit: limit() },
  }),
  'chats.list': Object.freeze({
    permission: 'read',
    method: 'chatsList',
    stream: false,
    params: { workspace_id: opaque(), limit: limit(), cursor: opaque() },
  }),
  'kb.search': Object.freeze({
    permission: 'read',
    method: 'kbSearch',
    stream: false,
    params: { query: { kind: 'string', min: 1, max: 500 }, workspace_id: opaque(), limit: limit(20) },
  }),
  // Document upload (permission "upload"; answered by the host's UploadManager, not by the engine;
  // the engine only receives the file after the user pressed Allow on the PC).
  'documents.upload.begin': Object.freeze({
    permission: 'upload',
    method: null,
    stream: false,
    params: {
      upload_id: uploadId,
      name: { kind: 'string', min: 3, max: 120 },
      size: { kind: 'int', min: 1, max: 25 * 1024 * 1024 },
      chunks: { kind: 'int', min: 1, max: 800 },
      hash: hex64,
      workspace_id: opaque(),
    },
  }),
  'documents.upload.chunk': Object.freeze({
    permission: 'upload',
    method: null,
    stream: false,
    params: {
      upload_id: uploadId,
      index: { kind: 'int', min: 0, max: 799 },
      data: { kind: 'string', min: 1, max: 43_700, pattern: /^[A-Za-z0-9_-]+$/ },
    },
  }),
  'documents.upload.finish': Object.freeze({ permission: 'upload', method: null, stream: false, params: { upload_id: uploadId } }),
  'documents.upload.status': Object.freeze({ permission: 'upload', method: null, stream: false, params: { upload_id: uploadId } }),
  'documents.upload.cancel': Object.freeze({ permission: 'upload', method: null, stream: false, params: { upload_id: uploadId } }),
  'chat.ask': Object.freeze({
    permission: 'chat',
    method: 'chatAsk',
    stream: true,
    params: {
      question: { kind: 'string', min: 1, max: 4000 },
      workspace_id: opaque(),
      conversation_id: opaque(),
    },
  }),
  'source.open': Object.freeze({
    permission: 'read',
    method: 'sourceOpen',
    stream: false,
    params: {
      source_id: opaque(false),
      max_chars: { kind: 'int', min: 100, max: 20000, optional: true },
    },
  }),
});

/**
 * The file ingestion method: called by the host only after the user confirmed an upload on the PC,
 * never directly by a request.
 */
export const INGEST_METHOD = 'documentIngest';

/** The only engine adapter methods the host will ever call. */
export const ENGINE_METHODS = Object.freeze([
  ...Object.values(REQUEST_TYPES).map((t) => t.method).filter((m) => m !== null),
  INGEST_METHOD,
]);

export const ERROR_CODES = Object.freeze([
  'bad_request',
  'unknown_type',
  'forbidden',
  'duplicate_id',
  'rate_limited',
  'too_large',
  'not_found',
  'engine_error',
  'session_expired',
]);

/** @param {FieldSpec} spec @param {unknown} v @returns {boolean} */
function valid(spec, v) {
  switch (spec.kind) {
    case 'string':
      return (
        typeof v === 'string' &&
        v.length >= (spec.min ?? 0) &&
        v.length <= spec.max &&
        (!spec.pattern || spec.pattern.test(v)) &&
        // no control characters except tab/newline in free text
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
      );
    case 'int':
      return typeof v === 'number' && Number.isSafeInteger(v) && v >= spec.min && v <= spec.max;
    case 'bool':
      return typeof v === 'boolean';
    case 'enum':
      return typeof v === 'string' && spec.values.includes(v);
    default:
      return false;
  }
}

/** @param {unknown} v */
const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validates a received request object.
 * @param {unknown} msg
 * @returns {{ ok: true, request: { id: string, type: string, params: Record<string, unknown> } }
 *   | { ok: false, id: string | null, code: string, message: string }}
 */
export function parseRequest(msg) {
  const fail = (id, code, message) => ({ ok: /** @type {const} */ (false), id, code, message });
  if (!isPlainObject(msg)) return fail(null, 'bad_request', 'A request must be an object.');
  const m = /** @type {Record<string, unknown>} */ (msg);
  const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : null;
  if (id === null) return fail(null, 'bad_request', 'Missing or invalid request id.');
  for (const k of Object.keys(m)) {
    if (k !== 'id' && k !== 'type' && k !== 'params') return fail(id, 'bad_request', 'Unknown field in request.');
  }
  if (typeof m.type !== 'string' || !Object.hasOwn(REQUEST_TYPES, m.type)) {
    return fail(id, 'unknown_type', 'This request type is not available on the phone.');
  }
  const spec = REQUEST_TYPES[/** @type {keyof typeof REQUEST_TYPES} */ (m.type)];
  const rawParams = m.params === undefined ? {} : m.params;
  if (!isPlainObject(rawParams)) return fail(id, 'bad_request', 'params must be an object.');
  const raw = /** @type {Record<string, unknown>} */ (rawParams);
  /** @type {Record<string, unknown>} */
  const params = {};
  for (const k of Object.keys(raw)) {
    if (!Object.hasOwn(spec.params, k)) return fail(id, 'bad_request', `Unknown parameter "${k.slice(0, 32)}".`);
  }
  for (const [k, fieldSpec] of Object.entries(spec.params)) {
    const v = raw[k];
    if (v === undefined) {
      if (!fieldSpec.optional) return fail(id, 'bad_request', `Missing parameter "${k}".`);
      continue;
    }
    if (!valid(fieldSpec, v)) return fail(id, 'bad_request', `Invalid parameter "${k}".`);
    params[k] = v;
  }
  return { ok: true, request: { id, type: m.type, params } };
}

/**
 * Serialises a message to bytes; refuses anything above MAX_MESSAGE_BYTES.
 * @param {unknown} obj
 */
export function encodeMessage(obj) {
  const bytes = utf8(JSON.stringify(obj));
  if (bytes.length > MAX_MESSAGE_BYTES) throw new ProtocolError('too_large');
  return bytes;
}

/**
 * Strict message decoding: valid UTF-8, valid JSON, a JSON object.
 * @param {Uint8Array} bytes
 * @returns {Record<string, unknown>}
 */
export function decodeMessage(bytes) {
  if (bytes.length > MAX_MESSAGE_BYTES) throw new ProtocolError('too_large');
  let obj;
  try {
    obj = JSON.parse(fromUtf8(bytes));
  } catch {
    throw new ProtocolError('bad_message');
  }
  if (!isPlainObject(obj)) throw new ProtocolError('bad_message');
  return /** @type {Record<string, unknown>} */ (obj);
}

/**
 * Light validation of what the PC sends back (the phone trusts the PC's key, but still never
 * trusts the shape).
 * @param {Record<string, unknown>} m
 * @returns {{ kind: 'result' | 'error' | 'chunk' | 'done' | 'event', id?: string, [k: string]: any }}
 */
export function parseResponse(m) {
  if (typeof m.event === 'string' && Object.keys(m).every((k) => k === 'event' || k === 'data')) {
    return { kind: 'event', event: m.event, data: m.data };
  }
  if (m.ok === false && m.id === null && isPlainObject(m.error)) {
    // The PC could not even read the request id (invalid id): an error that belongs to no request.
    return { kind: 'error', id: undefined, code: String(/** @type {any} */ (m.error).code ?? 'bad_request').slice(0, 40), message: '' };
  }
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) throw new ProtocolError('bad_message');
  if (m.ok === true && 'result' in m) return { kind: 'result', id: m.id, result: m.result };
  if (m.ok === false && isPlainObject(m.error)) {
    const e = /** @type {Record<string, unknown>} */ (m.error);
    return {
      kind: 'error',
      id: m.id,
      code: typeof e.code === 'string' ? e.code : 'engine_error',
      message: typeof e.message === 'string' ? e.message.slice(0, 500) : '',
    };
  }
  if ('chunk' in m) return { kind: 'chunk', id: m.id, chunk: m.chunk };
  if (m.done === true) return { kind: 'done', id: m.id, result: m.result };
  throw new ProtocolError('bad_message');
}
