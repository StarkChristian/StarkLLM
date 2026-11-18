// File types a workspace accepts and a knowledge base folder indexes (Settings > Knowledge Base shows this list).
// Keep equal to ALLOWED_EXTENSIONS in backend/app/api/documents.py and SUPPORTED_EXTENSIONS in backend/app/services/kb_service.py.
export const UPLOAD_EXTENSIONS = ['pdf', 'txt', 'md', 'markdown', 'csv', 'docx', 'xlsx', 'epub', 'pptx', 'html', 'json', 'xml', 'log', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'];

export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((e) => '.' + e).join(',');

export function isUploadable(name) {
  const ext = String(name || '').includes('.') ? String(name).split('.').pop().toLowerCase() : '';
  return UPLOAD_EXTENSIONS.includes(ext);
}
