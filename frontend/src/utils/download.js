// Save a file the backend makes on request (a calendar file), with the login header; nothing leaves the PC.
export async function downloadFile(url, headers, filename) {
  const res = await fetch(url, { headers });
  if (!res.ok) return false;
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return true;
}
