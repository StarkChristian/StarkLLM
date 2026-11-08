// Found on a real Windows PC (8 Nov 2026): better models were installed, but the app downloaded its own.
const test = require('node:test');
const assert = require('node:assert');
const { chooseModels } = require('../models');

const GB = 1024 ** 3;
// What `ollama list` showed on that PC, before StarkLLM downloaded anything.
const pc = [
  { name: 'qwen3:14b', size: 8.6 * GB, family: 'qwen3', parameterSize: '14.8B', capabilities: ['completion', 'tools', 'thinking'] },
  { name: 'qwen3.8:27b', size: 16.5 * GB, family: 'qwen35', parameterSize: '27.3B', capabilities: ['completion', 'vision', 'tools'] },
  { name: 'llama3.1:latest', size: 4.6 * GB, family: 'llama', parameterSize: '8.0B', capabilities: ['completion', 'tools'] },
  { name: 'qwen3-embedding:0.6b', size: 0.61 * GB, family: 'qwen3', parameterSize: '595.78M', capabilities: ['embedding'] },
  { name: 'nomic-embed-text:latest', size: 0.26 * GB, family: 'nomic-bert', parameterSize: '137M', capabilities: ['embedding'] },
];

test('a PC with a 12 GB graphics card uses its installed qwen3:14b and downloads nothing for chat', () => {
  const c = chooseModels({ installed: pc, hw: { ramBytes: 32 * GB, vramBytes: 12 * GB } });
  assert.strictEqual(c.text, 'qwen3:14b');
  assert.strictEqual(c.embedding, 'qwen3-embedding:0.6b');
  assert.deepStrictEqual(c.pull, []);
});

test('with 24 GB of video memory the larger Qwen 3.5 model is chosen and also reads images', () => {
  const c = chooseModels({ installed: pc, hw: { ramBytes: 64 * GB, vramBytes: 24 * GB } });
  assert.strictEqual(c.text, 'qwen3.8:27b');
  assert.strictEqual(c.vision, 'qwen3.8:27b');
});

test('documents indexed before keep the search model they were indexed with', () => {
  const c = chooseModels({ installed: pc, hw: { ramBytes: 32 * GB, vramBytes: 12 * GB }, existingIndex: true });
  assert.strictEqual(c.embedding, 'nomic-embed-text');
  assert.deepStrictEqual(c.pull, []);
});

test('a saved choice stays, and the search model never changes once saved', () => {
  const c = chooseModels({ installed: pc, hw: { ramBytes: 32 * GB, vramBytes: 12 * GB }, saved: { text: 'llama3.1:latest', embedding: 'nomic-embed-text', vision: 'llava' } });
  assert.strictEqual(c.text, 'llama3.1:latest');
  assert.strictEqual(c.embedding, 'nomic-embed-text');
});

test('a saved chat model that was deleted is replaced by the best installed one', () => {
  const c = chooseModels({ installed: pc, hw: { ramBytes: 32 * GB, vramBytes: 12 * GB }, saved: { text: 'mistral:7b', embedding: 'nomic-embed-text' } });
  assert.strictEqual(c.text, 'qwen3:14b');
});

test('without a graphics card, a model must fit in half of the RAM', () => {
  const c = chooseModels({ installed: pc, hw: { ramBytes: 16 * GB, vramBytes: 0 } });
  assert.strictEqual(c.text, 'llama3.1:latest'); // qwen3:14b (8.6 GB) does not fit in 8 GB
});

test('an empty Ollama gets the defaults downloaded; the image model waits for the first image', () => {
  const c = chooseModels({ installed: [], hw: { ramBytes: 16 * GB } });
  assert.deepStrictEqual(c.pull, ['nomic-embed-text', 'qwen2.5:7b']);
  assert.strictEqual(c.vision, 'llava');
});

test('Ollama cloud models are never chosen, because they do not run on this PC', () => {
  const c = chooseModels({ installed: [{ name: 'gpt-oss:120b-cloud', size: 384, family: 'gptoss', capabilities: ['completion'] }], hw: { ramBytes: 16 * GB } });
  assert.strictEqual(c.text, 'qwen2.5:7b');
});

test('a tiny model (under 3B) is not used for chat; a 3B one is preferred, and with only tiny ones the default is downloaded', () => {
  const tiny = { name: 'qwen3:0.6b', size: 0.5 * GB, family: 'qwen3', parameterSize: '751.63M', capabilities: ['completion', 'tools', 'thinking'] };
  const small = { name: 'qwen2.5:3b', size: 1.9 * GB, family: 'qwen2', parameterSize: '3.1B', capabilities: ['completion', 'tools'] };
  const vl = { name: 'qwen2.5vl:7b', size: 6 * GB, family: 'qwen25vl', parameterSize: '8.3B', capabilities: ['completion', 'vision'] };
  assert.strictEqual(chooseModels({ installed: [tiny, small], hw: { ramBytes: 16 * GB } }).text, 'qwen2.5:3b');
  const onlyTiny = chooseModels({ installed: [tiny], hw: { ramBytes: 16 * GB } });
  assert.strictEqual(onlyTiny.text, 'qwen2.5:7b');
  assert.ok(onlyTiny.pull.includes('qwen2.5:7b'));
  assert.strictEqual(chooseModels({ installed: [tiny, small, vl], hw: { ramBytes: 16 * GB } }).vision, 'qwen2.5vl:7b');
});
