const http = require('http');
const { randomUUID } = require('crypto');

const host = process.env.HOMEGATE_ADMIN_MOCK_HOST || '0.0.0.0';
const port = Number(process.env.HOMEGATE_ADMIN_MOCK_PORT || 6289);
const adminPassword = process.env.HOMEGATE_ADMIN_MOCK_PASSWORD || 'admin';
const pubky =
  process.env.HOMEGATE_ADMIN_MOCK_PUBKY ||
  'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';

function authorized(req) {
  const provided = req.headers['x-admin-password'];
  return !adminPassword || provided === adminPassword;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    send(res, 401, 'Unauthorized\n');
    return;
  }

  if (req.method === 'GET' && req.url === '/info') {
    send(res, 200, JSON.stringify({ public_key: pubky }), {
      'content-type': 'application/json',
    });
    return;
  }

  if (
    (req.method === 'GET' || req.method === 'POST') &&
    req.url === '/generate_signup_token'
  ) {
    send(res, 200, `homegate-dev-${randomUUID()}\n`, {
      'content-type': 'text/plain',
    });
    return;
  }

  send(res, 404, 'Not found\n');
});

server.listen(port, host, () => {
  console.log(`homegate admin mock listening on ${host}:${port}`);
});
