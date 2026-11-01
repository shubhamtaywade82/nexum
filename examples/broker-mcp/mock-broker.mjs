// Local stand-in for a broker REST API. Every request is recorded so tests can
// assert exactly how many times the server saw a call, with which headers.
import http from "node:http";

const defaultHandler = () => ({ status: 200, json: { ok: true } });

export function startMockBroker(handler = defaultHandler) {
  const hits = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const hit = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    hits.push(hit);
    const { status = 200, json = { ok: true }, headers = {} } = handler(hit, hits.length) ?? {};
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(json));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
}
