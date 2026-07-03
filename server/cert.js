// 휴대폰 카메라(getUserMedia)는 HTTPS 필수 — 최초 실행 시 자체 서명 인증서를 만들어 저장.
// 네트워크가 바뀌어 새 IP가 생기면(SAN 미커버) 유효기간이 남았어도 재생성한다.
const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const selfsigned = require('selfsigned');

// subjectAltName 문자열에서 IP 목록을 파싱한다.
function sanIPs(x509) {
  const out = new Set();
  for (const part of String(x509.subjectAltName || '').split(',')) {
    const m = part.trim().match(/^IP Address:(.+)$/i);
    if (m) out.add(m[1].trim());
  }
  return out;
}

function loadOrCreateCert(certDir, ips) {
  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.crt');

  try {
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    const x509 = new X509Certificate(cert);
    const stillValid = new Date(x509.validTo).getTime() > Date.now() + 24 * 3600 * 1000;
    const san = sanIPs(x509);
    const coversAllIPs = (ips || []).every((ip) => san.has(ip));
    if (stillValid && coversAllIPs) return { key, cert };
  } catch (_) {
    // 없거나 손상된 경우 새로 생성
  }

  const attrs = [{ name: 'commonName', value: 'BEWEX' }];
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...(ips || []).map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });

  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

module.exports = { loadOrCreateCert };
