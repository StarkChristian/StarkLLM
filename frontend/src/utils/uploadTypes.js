// File types a workspace accepts and a knowledge base folder indexes (Settings > Knowledge Base shows this list).
// Keep equal to ALLOWED_EXTENSIONS in backend/app/api/documents.py and SUPPORTED_EXTENSIONS in backend/app/services/kb_service.py.
export const UPLOAD_EXTENSIONS = ['pdf', 'txt', 'md', 'markdown', 'csv', 'docx', 'xlsx', 'epub', 'pptx', 'html', 'json', 'xml', 'log', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'];

// Recordings (meetings, voice memos, the sound of videos): a workspace writes them down with times on this PC
// (docs/roadmap-2026-12.md, R3). Not for knowledge base folders: a folder of music must not be transcribed by itself.
// Keep equal to RECORDING_EXTENSIONS in backend/app/services/recordings.py.
export const RECORDING_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'wma', 'webm', 'mp4', 'mov', 'mkv'];

export const UPLOAD_ACCEPT = [...UPLOAD_EXTENSIONS, ...RECORDING_EXTENSIONS].map((e) => '.' + e).join(',');

export const isRecording = (name) => RECORDING_EXTENSIONS.includes(String(name || '').split('.').pop().toLowerCase());

export function isUploadable(name) {
  const ext = String(name || '').includes('.') ? String(name).split('.').pop().toLowerCase() : '';
  return UPLOAD_EXTENSIONS.includes(ext) || RECORDING_EXTENSIONS.includes(ext);
}
