// 휴대폰 브라우저에서 카메라(getUserMedia)를 쓰려면 HTTPS가 필수라서
// 최초 실행 시 자체 서명 인증서를 만들어 사용자 데이터 폴더에 저장한다.
const fs = require('fs');
const path = require('path');
const { X509Certificate } = require('crypto');
const selfsigned = require('selfsigned');

function loadOrCreateCert(certDir, ips) {
  const keyPath = path.join(certDir, 'server.key');
  const certPath = path.join(certDir, 'server.crt');

  try {
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    const x509 = new X509Certificate(cert);
    const stillValid = new Date(x509.validTo).getTime() > Date.now() + 24 * 3600 * 1000;
    if (stillValid) return { key, cert };
  } catch (_) {
    // 없거나 손상된 경우 새로 생성
  }

  const attrs = [{ name: 'commonName', value: 'PhoneCam Viewer' }];
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
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
