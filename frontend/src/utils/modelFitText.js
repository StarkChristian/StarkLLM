import { t } from '../i18n';
import { memoryText, sizeText, durationParts, mainGraphics } from './modelFit';

// The texts of the model picker: "Fits well" / "Tight (slower)" / "Will not fit" and why, in one sentence.

export function fitLabel(fit) {
  if (!fit) return '';
  if (fit.fit === 'good') return t('Fits well');
  if (fit.fit === 'tight') return t('Tight (slower)');
  return t('Will not fit');
}

export function fitReason(fit) {
  if (!fit) return '';
  const need = memoryText(fit.need_bytes);
  const vram = memoryText(fit.vram_bytes);
  const ram = memoryText(fit.ram_bytes);
  switch (fit.reason) {
    case 'gpu': return t('Needs about {need}; your graphics card has {vram}.', { need, vram });
    case 'igpu': return t('Needs about {need}; the integrated graphics may use {vram} of the memory.', { need, vram });
    case 'cpu': return t('Needs about {need}; runs on the processor with {ram} of memory.', { need, ram });
    case 'split': return t('Needs about {need}; your graphics card has {vram}, the rest runs on the processor and is slower.', { need, vram });
    case 'cpu_slow': return t('Needs about {need}; without a suitable graphics card it runs on the processor and is slower.', { need });
    case 'disk': return t('Needs {size} of free disk space; only {free} are free.', { size: sizeText(fit.size_bytes), free: sizeText(fit.disk_free) });
    default:
      return fit.vram_bytes
        ? t('Needs about {need}; this PC has {ram} of memory and {vram} of video memory, which is not enough.', { need, ram, vram })
        : t('Needs about {need}; this PC has {ram} of memory, which is not enough.', { need, ram });
  }
}

export function durationText(seconds) {
  const d = durationParts(seconds);
  if (d.unit === 's') return t('{n} s', { n: d.n });
  if (d.unit === 'min') return t('{n} min', { n: d.n });
  return t('{h} h {m} min', { h: d.h, m: d.m });
}

/** One sentence: why this model is recommended for this PC (tier from core/model_tiers.json). */
export function recommendationSentence(recommendation, hardware) {
  if (!recommendation?.text?.name) return '';
  const model = recommendation.text.name;
  const tier = recommendation.tier || '';
  const card = mainGraphics({ gpus: (hardware?.gpus || []).filter((g) => g.kind !== 'integrated') });
  const vram = card ? memoryText(card.vram_total) : '';
  if (tier === 'gpu_24') return t('StarkLLM recommends {model} because your graphics card with {vram} holds a larger model, which gives more careful answers.', { model, vram });
  if (tier.startsWith('gpu')) return t('StarkLLM recommends {model} because it fits completely in the {vram} of your graphics card and answers quickly.', { model, vram });
  return t('StarkLLM recommends {model}, a small model that answers quickly on the processor, because this PC has no graphics card of its own for AI.', { model });
}

/** "32 GB of memory, NVIDIA GeForce RTX 4070 with 12 GB, 120.4 GB free disk space" */
export function hardwareSummary(hw) {
  if (!hw) return '';
  const parts = [];
  if (hw.ram_total) parts.push(t('{ram} of memory', { ram: memoryText(hw.ram_total) }));
  const gpu = mainGraphics(hw);
  if (gpu) parts.push(t('{gpu} with {vram}', { gpu: gpu.name || t('graphics card'), vram: memoryText(gpu.vram_total) }));
  else parts.push(t('no graphics card for AI'));
  if (hw.disk_free != null) parts.push(t('{free} free disk space', { free: sizeText(hw.disk_free) }));
  return parts.join(', ');
}
