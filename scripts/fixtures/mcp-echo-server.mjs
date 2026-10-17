#!/usr/bin/env node
/**
 * 最小 MCP stdio fixture（仅 node 内置模块）。
 *
 * 供 `verify:extension-foundation` 的 dsh-mcp-client/mcp-resources 探针使用：
 * - `server/discover` 一律按 JSON-RPC 方法不存在返回，触发客户端回退到
 *   2025-era `initialize`（探针可继续验证 legacy 握手 + 工具/资源通路）。
 * - 暴露一个 echo 工具与一个静态文本资源，用于断言工具调用和资源读取结果
 *   能穿过 zcode loop 的 dsh 管线进入下一请求。
 *
 * 传输是 newline-delimited JSON-RPC（MCP stdio 现行 framing）。
 */
process.stdin.setEncoding("utf8");

let buffered = "";
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline).replace(/\r$/, "");
    buffered = buffered.slice(newline + 1);
    if (line.trim().length === 0) continue;
    handle(JSON.parse(line));
  }
});

process.stdin.on("end", () => process.exit(0));

const TOOL_RESULT_TEXT = "echo:";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  if (typeof message !== "object" || message === null) return;
  const { id, method, params } = message;
  if (method === undefined) return;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "server/discover":
      if (isRequest) error(id, -32601, "server/discover is not supported by this legacy fixture");
      return;
    case "initialize":
      if (isRequest) {
        result(id, {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
          serverInfo: { name: "foundation-fixture", version: "1.0.0" },
          instructions: "MCP_FIXTURE_INSTRUCTIONS_MARKER: fixture server instructions",
        });
      }
      return;
    case "notifications/initialized":
      return;
    case "ping":
      if (isRequest) result(id, {});
      return;
    case "tools/list":
      if (isRequest) {
        result(id, {
          tools: [
            {
              name: "echo",
              description: "Echo the provided text.",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
                additionalProperties: false,
              },
            },
          ],
        });
      }
      return;
    case "tools/call":
      if (!isRequest) return;
      if (params?.name !== "echo") {
        error(id, -32602, `unknown tool: ${String(params?.name)}`);
        return;
      }
      result(id, {
        content: [{ type: "text", text: `${TOOL_RESULT_TEXT}${String(params?.arguments?.text ?? "")}` }],
      });
      return;
    case "resources/list":
      if (isRequest) {
        result(id, {
          resources: [{ uri: "fixture://greeting", name: "greeting", mimeType: "text/plain" }],
        });
      }
      return;
    case "resources/templates/list":
      if (isRequest) result(id, { resourceTemplates: [] });
      return;
    case "resources/read":
      if (!isRequest) return;
      if (params?.uri !== "fixture://greeting") {
        error(id, -32602, `unknown resource: ${String(params?.uri)}`);
        return;
      }
      result(id, {
        contents: [{ uri: "fixture://greeting", mimeType: "text/plain", text: "hello from mcp resource" }],
      });
      return;
    default:
      if (isRequest) error(id, -32601, `method not found: ${method}`);
  }
}
