
const http = require('http');

const HOST = 'localhost';
const PORT = process.env.PORT || 3000;

const endpoints = [
  '/', 
  '/health',
  '/api',
  '/api/lenders',
  '/api/lender-products',
  '/api/lender-requirements',
  '/api/ai'
];

function testEndpoint(path) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'GET', timeout: 2000 },
      (res) => {
        resolve({ path, status: res.statusCode });
      }
    );

    req.on('error', () => resolve({ path, status: 'FAIL' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ path, status: 'TIMEOUT' });
    });

    req.end();
  });
}

(async () => {
  console.log('\n=== ENDPOINT TEST RESULTS ===\n');

  for (const ep of endpoints) {
    const result = await testEndpoint(ep);

    if (result.status === 200) {
      console.log(`✅ ${ep}`);
    } else {
      console.log(`❌ ${ep} -> ${result.status}`);
    }
  }

  console.log('\nDONE\n');
})();

