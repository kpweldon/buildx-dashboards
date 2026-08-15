// Minimal MCP server over Streamable HTTP (JSON-RPC 2.0 on a single POST
// endpoint). Written by hand rather than pulled from the SDK so the Worker
// ships with zero dependencies and no bundling step.

export const SERVER_INFO = { name: 'buildx-nationality', version: '1.0.0' };

// Newest first. We echo back whichever the client asks for if we know it.
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: data === undefined ? { code, message } : { code, message, data },
});

/**
 * Handle one JSON-RPC message.
 * @param {object} message parsed JSON-RPC request or notification
 * @param {object} registry map of tool name -> {definition, handler}
 * @returns {Promise<object|null>} response, or null for notifications
 */
export async function handleRpc(message, registry) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return fail(null, INVALID_REQUEST, 'Request must be a JSON-RPC object.');
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (typeof method !== 'string') {
    return isNotification ? null : fail(id, INVALID_REQUEST, '`method` must be a string.');
  }

  // Notifications get no response body at all, whatever they are.
  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Nationality tools for BuildX. predict_nationality infers likely countries of ' +
          'origin from a first name; get_country_info returns reference data for a country. ' +
          'Predictions are population statistics about a name string, never a determination ' +
          'about a specific person.',
      });
    }

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, { tools: Object.values(registry).map((t) => t.definition) });

    case 'tools/call': {
      const name = params?.name;
      const tool = typeof name === 'string' ? registry[name] : undefined;
      if (!tool) {
        return fail(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      }
      try {
        const result = await tool.handler(params?.arguments ?? {});
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
          isError: false,
        });
      } catch (err) {
        // Tool-level failures are reported inside the result so the model can
        // read the message and adjust, per the MCP tool-error convention.
        return ok(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    // Advertised as unsupported in `capabilities`, but answer politely rather
    // than erroring if a client probes anyway.
    case 'resources/list':
      return ok(id, { resources: [] });
    case 'prompts/list':
      return ok(id, { prompts: [] });

    default:
      return isNotification ? null : fail(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

/**
 * Handle a raw POST body (single message or batch).
 * @returns {Promise<{status: number, body: object|array|null}>}
 */
export async function handleRpcPayload(rawBody, registry) {
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: fail(null, PARSE_ERROR, 'Request body is not valid JSON.') };
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return { status: 400, body: fail(null, INVALID_REQUEST, 'Batch must not be empty.') };
    }
    const responses = (await Promise.all(payload.map((m) => handleRpc(m, registry)))).filter(
      (r) => r !== null,
    );
    // An all-notification batch is acknowledged with 202 and no body.
    return responses.length === 0 ? { status: 202, body: null } : { status: 200, body: responses };
  }

  try {
    const response = await handleRpc(payload, registry);
    return response === null ? { status: 202, body: null } : { status: 200, body: response };
  } catch (err) {
    return {
      status: 500,
      body: fail(payload?.id ?? null, INTERNAL_ERROR, `Internal error: ${err.message}`),
    };
  }
}
