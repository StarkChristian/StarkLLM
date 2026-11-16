#!/usr/bin/env node
// Entry point: reads the configuration from environment variables and starts the relay.
import { createRelay, DEFAULTS } from './server.js';
import { readFileSync } from 'node:fs';

const num = (name, def) => {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid value for ${name}`);
    process.exit(2);
  }
  return n;
};

let version = '0.0.0';
try {
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
} catch { /* keep default */ }

const relay = createRelay({
  version,
  trustedIpHeader: process.env.RELAY_TRUSTED_IP_HEADER?.toLowerCase() || null,
  maxPhonesPerMailbox: num('RELAY_MAX_PHONES_PER_MAILBOX', DEFAULTS.maxPhonesPerMailbox),
  maxPcPerIp: num('RELAY_MAX_PC_PER_IP', DEFAULTS.maxPcPerIp),
  maxPhonesPerIp: num('RELAY_MAX_PHONES_PER_IP', DEFAULTS.maxPhonesPerIp),
  newConnectionsPerIpPerMinute: num('RELAY_CONNECTIONS_PER_IP_PER_MINUTE', DEFAULTS.newConnectionsPerIpPerMinute),
  bytesPerMailboxPerDay: num('RELAY_BYTES_PER_MAILBOX_PER_DAY', DEFAULTS.bytesPerMailboxPerDay),
});

const port = await relay.listen(num('PORT', 8787), process.env.HOST ?? '0.0.0.0');
console.log(JSON.stringify({ ev: 'listening', port, version }));

const stop = async () => {
  await relay.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
