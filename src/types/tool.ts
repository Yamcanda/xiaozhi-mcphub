// Shared tool DTO without backend runtime dependencies.
export interface Tool {
  name: string; // Name of the tool
  title?: string; // Human-readable title
  description: string; // Brief description of the tool
  defaultDescription?: string; // Upstream tool description before any MCPHub override is applied
  hasDescriptionOverride?: boolean; // Whether MCPHub is currently overriding the upstream description
  inputSchema: Record<string, unknown>; // Input schema for the tool
  outputSchema?: Record<string, unknown>; // Optional schema for structured output
  annotations?: Record<string, unknown>; // Standard MCP tool annotations
  execution?: Record<string, unknown>; // Standard MCP execution metadata
  icons?: Array<Record<string, unknown>>; // Standard MCP icons
  _meta?: Record<string, unknown>; // Extension metadata, including MCP Apps metadata
  enabled?: boolean; // Whether the tool is enabled (optional, defaults to true)
}
