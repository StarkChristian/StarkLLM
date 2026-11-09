// File types a workspace accepts. Keep equal to ALLOWED_EXTENSIONS in backend/app/api/documents.py.
export const UPLOAD_EXTENSIONS = ['pdf', 'txt', 'md', 'markdown', 'csv', 'docx', 'xlsx', 'html', 'json', 'xml', 'log', 'png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff'];

export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((e) => '.' + e).join(',');

export function isUploadable(name) {
  const ext = String(name || '').includes('.') ? String(name).split('.').pop().toLowerCase() : '';
  return UPLOAD_EXTENSIONS.includes(ext);
}
