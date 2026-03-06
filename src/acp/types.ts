export type JsonRpcId = number;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

export type JsonRpcError = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type JsonRpcIncoming = JsonRpcResponse | JsonRpcNotification | JsonRpcRequest;

export type CopilotAuthMethod = {
  id: string;
  name?: string;
  description?: string;
  _meta?: Record<string, unknown>;
};

export type InitializeResult = {
  protocolVersion: number;
  authMethods?: CopilotAuthMethod[];
  agentInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
};

export type SessionNewResult = {
  sessionId: string;
};

export type SessionPromptResult = {
  stopReason: string;
  userMessageId?: string;
};

export type SessionUpdateNotification = {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: {
      type?: string;
      text?: string;
    };
    title?: string;
    toolCallId?: string;
    [key: string]: unknown;
  };
};

export type CopilotAskRequest = {
  prompt: string;
  context?: string;
};

export type CopilotAskResult = {
  text: string;
  meta: {
    agentName?: string;
    agentVersion?: string;
    sessionId?: string;
    stopReason?: string;
    updateTypes: string[];
    toolCalls: string[];
    stderr: string[];
  };
};
