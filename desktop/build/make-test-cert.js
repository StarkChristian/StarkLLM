// A self-signed code signing certificate made at run time, for dry runs of the signing chain without the real
// certificate (CI, the server). Nothing here is secret and nothing is kept: the folder is temporary.
//
//   node build/make-test-cert.js <folder>     prints shell/PowerShell-neutral KEY=value lines (see below)
//
// The subject looks like the Certum open source certificate (a common name with a comma in it), so the publisher
// name check is exercised with the hard case.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { powershell } = require('./signature');

const TEST_CN = 'Open Source Developer, StarkLLM Test (not a real certificate)';

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`${label} failed: ${r.error ? r.error.message : (r.stderr || r.stdout)}`);
  return r.stdout;
}

// returns { pfx, password, pem (certificate only, for STARKLLM_TEST_CA), cn }
function makeTestCert(dir, cn = TEST_CN) {
  fs.mkdirSync(dir, { recursive: true });
  const password = crypto.randomBytes(12).toString('hex');
  const pfx = path.join(dir, 'test-sign.pfx');
  const pem = path.join(dir, 'test-sign.pem');
  if (process.platform === 'win32') {
    const ps = [
      `$c = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN="${cn}"' -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(2)`,
      `Export-PfxCertificate -Cert $c -FilePath '${pfx}' -Password (ConvertTo-SecureString '${password}' -AsPlainText -Force) | Out-Null`,
      `Export-Certificate -Cert $c -FilePath '${path.join(dir, 'test-sign.cer')}' | Out-Null`,
      'Remove-Item $c.PSPath',
    ].join('; ');
    const r = powershell(ps);
    if (r.status !== 0 || !fs.existsSync(pfx)) throw new Error(`New-SelfSignedCertificate failed: ${r.stderr || r.stdout}`);
    return { pfx, password, pem: null, cer: path.join(dir, 'test-sign.cer'), cn };
  }
  const key = path.join(dir, 'test-sign.key');
  run('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', key, '-out', pem, '-days', '2',
    '-subj', `/CN=${cn}`, '-addext', 'keyUsage=critical,digitalSignature', '-addext', 'extendedKeyUsage=codeSigning'], 'openssl req');
  run('openssl', ['pkcs12', '-export', '-inkey', key, '-in', pem, '-out', pfx, '-passout', `pass:${password}`], 'openssl pkcs12');
  fs.rmSync(key, { force: true });
  return { pfx, password, pem, cer: null, cn };
}

module.exports = { makeTestCert, TEST_CN };

if (require.main === module) {
  const c = makeTestCert(path.resolve(process.argv[2] || 'test-cert'));
  console.log(`STARKLLM_SIGN_PFX=${c.pfx}`);
  console.log(`STARKLLM_SIGN_PFX_PASSWORD=${c.password}`);
  if (c.pem) console.log(`STARKLLM_TEST_CA=${c.pem}`);
  console.log(`CERT_CN=${c.cn}`);
}
