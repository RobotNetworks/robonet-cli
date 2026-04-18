import { describe, it, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import { MCPClient } from "../src/mcp-client.js";
import { MCPError } from "../src/errors.js";

describe("MCPClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("initialize sends correct JSON-RPC payload", async () => {
    const captured: { body: string }[] = [];

    globalThis.fetch = async (_input, init) => {
      captured.push({ body: init!.body as string });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "test" },
            capabilities: {},
          },
        }),
        {
          status: 200,
          headers: { "MCP-Session-Id": "session-123" },
        },
      );
    };

    const client = new MCPClient("https://mcp.example.test/mcp", "bearer-token");
    await client.initialize();

    assert.equal(captured.length, 1);
    const body = JSON.parse(captured[0].body);
    assert.equal(body.method, "initialize");
    assert.equal(body.jsonrpc, "2.0");
    assert.ok(body.params.clientInfo);
  });

  it("initialize is idempotent", async () => {
    let callCount = 0;

    globalThis.fetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
        { status: 200, headers: { "MCP-Session-Id": "session-abc" } },
      );
    };

    const client = new MCPClient("https://mcp.example.test/mcp", "bearer-token");
    await client.initialize();
    await client.initialize();

    assert.equal(callCount, 1);
  });

  it("listTools returns parsed tools array", async () => {
    let callCount = 0;

    globalThis.fetch = async (_input, init) => {
      callCount++;
      const body = JSON.parse(init!.body as string);
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "MCP-Session-Id": "s1" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "send_message", description: "Send a message" },
              { name: "list_threads", description: "List threads" },
            ],
          },
        }),
        { status: 200 },
      );
    };

    const client = new MCPClient("https://mcp.example.test/mcp", "bearer-token");
    const tools = await client.listTools();

    assert.equal(tools.length, 2);
    assert.equal(tools[0].name, "send_message");
    assert.equal(tools[1].name, "list_threads");
    assert.equal(callCount, 2); // initialize + tools/list
  });

  it("callTool parses JSON text content", async () => {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string);
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "MCP-Session-Id": "s1" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: '{"id":"msg_1","status":"sent"}' }],
          },
        }),
        { status: 200 },
      );
    };

    const client = new MCPClient("https://mcp.example.test/mcp", "bearer-token");
    const result = await client.callTool("send_message", { content: "hello" });

    assert.equal(result.id, "msg_1");
    assert.equal(result.status, "sent");
  });

  it("callTool returns raw text when not valid JSON", async () => {
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(init!.body as string);
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }),
          { status: 200, headers: { "MCP-Session-Id": "s1" } },
        );
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [{ type: "text", text: "not json" }],
          },
        }),
        { status: 200 },
      );
    };

    const client = new MCPClient("https://mcp.example.test/mcp", "bearer-token");
    const result = await client.callTool("echo", {});

    assert.equal(result.raw, "not json");
  });

  it("throws MCPError on HTTP failure", async () => {
    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    const client = new MCPClient("https://mcp.example.test/mcp", "bearer-token");
    await assert.rejects(() => client.initialize(), MCPError);
  });

  it("throws MCPError on JSON-RPC error response", async () => {
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32600, message: "Invalid request" },
        }),
        { status: 200, headers: { "MCP-Session-Id": "s1" } },
      );
    };

    const client = new MCPClient("https://mcp.example.test/mcp", "bearer-token");
    await assert.rejects(() => client.initialize(), MCPError);
  });

  it("sends session ID header after initialization", async () => {
    const capturedHeaders: Record<string, string>[] = [];

    globalThis.fetch = async (_input, init) => {
      capturedHeaders.push(init!.headers as Record<string, string>);
      const body = JSON.parse(init!.body as string);
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: body.method === "tools/list" ? { tools: [] } : {},
        }),
        { status: 200, headers: { "MCP-Session-Id": "session-xyz" } },
      );
    };

    const client = new MCPClient("https://mcp.example.test/mcp", "bearer-token");
    await client.listTools();

    // First call (initialize) should not have session ID
    assert.equal(capturedHeaders[0]["MCP-Session-Id"], undefined);
    // Second call (tools/list) should have session ID
    assert.equal(capturedHeaders[1]["MCP-Session-Id"], "session-xyz");
  });
});
