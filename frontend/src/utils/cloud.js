// Where a chat request goes when it leaves this PC. Mirrors cloud_host() in backend/app/services/llm_service.py:
// an OpenAI-compatible server on this PC or the local network (LM Studio, vLLM) counts as local.
export function cloudHostFor(provider, baseUrl) {
  const routed = provider === 'openai_compatible' || (baseUrl && !baseUrl.toLowerCase().includes('ollama') && !baseUrl.endsWith('/api'));
  if (!routed) return null;
  let host = '';
  try {
    host = new URL(baseUrl || 'https://api.openai.com/v1').hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
  if (!host || host === 'localhost' || host === 'host.docker.internal' || host === '::1') return null;
  if (/\.(local|localhost|internal|lan)$/.test(host)) return null;
  const v4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)) return null;
  }
  if (/^(fc|fd|fe80)/.test(host)) return null;
  return host;
}

export function currentCloudHost() {
  try {
    return cloudHostFor(localStorage.getItem('llm_provider') || 'ollama', localStorage.getItem('llm_base_url') || '');
  } catch {
    return null;
  }
}
