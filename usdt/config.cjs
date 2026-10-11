const ports = {
  node: 23450,
  alto: 23451,
  provider: 23452,
  gateway: 23453,
  control: 23454,
  upstream: 23455,
  orchestra: 23456,
  layerzero: 23457,
  reader: 23458,
};
const urls = Object.fromEntries(
  Object.entries(ports).map(([name, port]) => [name, `http://127.0.0.1:${port}`]),
);
module.exports = { ports, urls, state: '/state' };
