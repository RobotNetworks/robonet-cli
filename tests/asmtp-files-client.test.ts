import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";

import { FilesClient } from "../src/asmtp/files-client.js";
import {
  AsmtpApiError,
  AsmtpNetworkUnreachableError,
} from "../src/asmtp/errors.js";

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Replace `globalThis.fetch` with a scripted sequence of responses. Each
 * call pops the next entry from `responses` and returns whatever it
 * yields (a Response, a promise of one, or a thrown error). Unexpected
 * extra calls fail the test loudly rather than hanging on the response
 * queue.
 */
function withFetchMock(
  responses: Array<(call: CapturedCall) => Response | Promise<Response>>,
): { readonly calls: readonly CapturedCall[] } {
  const calls: CapturedCall[] = [];
  let i = 0;
  globalThis.fetch = async (input, init) => {
    const call: CapturedCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    if (i >= responses.length) {
      throw new Error(`unexpected extra fetch call to ${call.url}`);
    }
    return responses[i++](call);
  };
  return { calls };
}

const BASE = "https://api.example/v1";
const TOKEN = "test-token";
const FILE_ID = "file_01HW7Z9KQX1MS2D9P5VC3GZ8AB";

function makeClient(): FilesClient {
  return new FilesClient(BASE, TOKEN);
}

describe("FilesClient.upload", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs to /files with bearer + idempotency-key and returns parsed body", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            id: FILE_ID,
            status: "ready",
            filename: "hello.bin",
            content_type: "application/octet-stream",
            size_bytes: 4,
            created_at: 1_700_000_000_000,
            expires_at: 1_700_000_086_400,
          }),
          { status: 201 },
        ),
    ]);
    const result = await makeClient().upload({
      bytes: new Uint8Array([1, 2, 3, 4]),
      filename: "hello.bin",
      contentType: "application/octet-stream",
    });
    assert.equal(result.id, FILE_ID);
    assert.equal(result.status, "ready");
    assert.equal(result.filename, "hello.bin");
    assert.equal(result.content_type, "application/octet-stream");
    assert.equal(result.size_bytes, 4);

    const call = calls[0]!;
    assert.equal(call.url, `${BASE}/files`);
    assert.equal(call.init.method, "POST");

    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], `Bearer ${TOKEN}`);
    assert.ok(
      typeof headers["Idempotency-Key"] === "string" &&
        headers["Idempotency-Key"].length > 0,
      "Idempotency-Key must be set so a retried upload doesn't double-store",
    );
    assert.ok(
      typeof headers["User-Agent"] === "string" &&
        headers["User-Agent"].length > 0,
    );
    // Body MUST be a FormData; the operator's multipart parser depends on
    // the right Content-Type boundary fetch derives from the body type.
    assert.ok(
      call.init.body instanceof FormData,
      "upload body MUST be FormData so fetch sets the multipart Content-Type",
    );
    // The single field is named "file" — the in-tree operator (and the
    // hosted backend's multipart parser) MUST find it under that name.
    const form = call.init.body;
    const fileField = form.get("file");
    assert.ok(
      fileField instanceof Blob,
      "form must carry a Blob under the `file` field",
    );
  });

  it("generates a unique Idempotency-Key per call so retries don't collide", async () => {
    const { calls } = withFetchMock([
      () =>
        new Response(
          JSON.stringify({
            id: FILE_ID,
            status: "ready",
            filename: "hello.bin",
            content_type: "application/octet-stream",
            size_bytes: 4,
            created_at: 1_700_000_000_000,
            expires_at: 1_700_000_086_400,
          }),
          { status: 201 },
        ),
      () =>
        new Response(
          JSON.stringify({
            id: FILE_ID,
            status: "ready",
            filename: "hello.bin",
            content_type: "application/octet-stream",
            size_bytes: 4,
            created_at: 1_700_000_000_000,
            expires_at: 1_700_000_086_400,
          }),
          { status: 201 },
        ),
    ]);
    const client = makeClient();
    await client.upload({
      bytes: new Uint8Array([0]),
      filename: "a.bin",
      contentType: "application/octet-stream",
    });
    await client.upload({
      bytes: new Uint8Array([0]),
      filename: "a.bin",
      contentType: "application/octet-stream",
    });
    const k1 = (calls[0]!.init.headers as Record<string, string>)[
      "Idempotency-Key"
    ];
    const k2 = (calls[1]!.init.headers as Record<string, string>)[
      "Idempotency-Key"
    ];
    assert.notEqual(k1, k2, "two upload calls MUST produce distinct keys");
  });

  it("translates a non-2xx response to AsmtpApiError", async () => {
    withFetchMock([
      () =>
        new Response(
          JSON.stringify({ error: { code: "PAYLOAD_TOO_LARGE", message: "10MB cap" } }),
          { status: 413 },
        ),
    ]);
    await assert.rejects(
      () =>
        makeClient().upload({
          bytes: new Uint8Array(1),
          filename: "x.bin",
          contentType: "application/octet-stream",
        }),
      (err) => {
        assert.ok(err instanceof AsmtpApiError);
        assert.equal(err.status, 413);
        assert.equal(err.code, "PAYLOAD_TOO_LARGE");
        return true;
      },
    );
  });

  it("translates a fetch throw to AsmtpNetworkUnreachableError", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await assert.rejects(
      () =>
        makeClient().upload({
          bytes: new Uint8Array(1),
          filename: "x.bin",
          contentType: "application/octet-stream",
        }),
      AsmtpNetworkUnreachableError,
    );
  });
});

describe("FilesClient.download", () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GETs /files/{id} with the bearer when given a bare file_id", async () => {
    const payload = new Uint8Array([10, 20, 30, 40, 50]);
    const { calls } = withFetchMock([
      () =>
        new Response(payload, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-disposition": 'attachment; filename="hello.png"',
          },
        }),
    ]);
    const result = await makeClient().download(FILE_ID);
    assert.deepEqual(result.bytes, payload);
    assert.equal(result.contentType, "image/png");
    assert.equal(result.filename, "hello.png");

    const call = calls[0]!;
    assert.equal(call.url, `${BASE}/files/${FILE_ID}`);
    assert.equal(call.init.method, "GET");
    const headers = call.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], `Bearer ${TOKEN}`);
  });

  it("returns filename: null when the response has no Content-Disposition", async () => {
    withFetchMock([
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    ]);
    const result = await makeClient().download(FILE_ID);
    assert.equal(result.filename, null);
  });

  it("falls back to application/octet-stream when the server omits content-type", async () => {
    withFetchMock([
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
        }),
    ]);
    const result = await makeClient().download(FILE_ID);
    assert.equal(result.contentType, "application/octet-stream");
  });

  it("attaches no Authorization header when given an absolute URL outside baseUrl", async () => {
    const signedUrl =
      "https://signed.example/blobs/foo?sig=abc&exp=999&token=xyz";
    const { calls } = withFetchMock([
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    ]);
    await makeClient().download(signedUrl);
    const call = calls[0]!;
    assert.equal(call.url, signedUrl);
    const headers = call.init.headers as Record<string, string>;
    assert.equal(
      headers["Authorization"],
      undefined,
      "signed off-operator URLs carry credentials in the URL itself; sending the bearer leaks the agent token to a non-operator origin",
    );
    assert.ok(typeof headers["User-Agent"] === "string");
  });

  it("attaches the bearer when an absolute URL prefixes the operator's baseUrl", async () => {
    const url = `${BASE}/files/${FILE_ID}?signed=1`;
    const { calls } = withFetchMock([
      () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    ]);
    await makeClient().download(url);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], `Bearer ${TOKEN}`);
  });

  it("translates a non-2xx response to AsmtpApiError", async () => {
    withFetchMock([() => new Response("", { status: 404 })]);
    await assert.rejects(
      () => makeClient().download(FILE_ID),
      (err) => {
        assert.ok(err instanceof AsmtpApiError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  it("translates a fetch throw to AsmtpNetworkUnreachableError", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNRESET");
    };
    await assert.rejects(
      () => makeClient().download(FILE_ID),
      AsmtpNetworkUnreachableError,
    );
  });
});
