import { BaseToolset, FunctionTool } from '@google/adk';
import type { BaseTool, ReadonlyContext } from '@google/adk';
import type { Schema } from '@google/genai';
import { Type } from '@google/genai';

// ─── OpenAPI 3.x document interfaces ────────────────────────────────────────

interface OpenApiSchema {
  type?: string;
  $ref?: string;
  description?: string;
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  required?: string[];
  enum?: string[];
  allOf?: OpenApiSchema[];
}

interface OpenApiParameter {
  name: string;
  in: string; // 'path' | 'query' | 'header' | 'cookie'
  required?: boolean;
  description?: string;
  schema?: OpenApiSchema;
}

interface OpenApiRequestBody {
  $ref?: string;
  content?: Record<string, { schema?: OpenApiSchema }>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
}

interface OpenApiComponents {
  schemas?: Record<string, OpenApiSchema>;
  [key: string]: unknown;
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: OpenApiComponents;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function resolveRef(schema: OpenApiSchema, components: OpenApiComponents): OpenApiSchema {
  if (!schema?.$ref) return schema;
  // '#/components/schemas/CreateHoldDto' → ['components', 'schemas', 'CreateHoldDto']
  const parts = schema.$ref.replace('#/', '').split('/');
  const root: Record<string, unknown> = { components };
  let current: unknown = root;
  for (const part of parts) {
    current = (current as Record<string, unknown>)?.[part];
    if (current === undefined) return schema;
  }
  return (current as OpenApiSchema) ?? schema;
}

const OPENAPI_TO_GEMINI_TYPE: Record<string, Type> = {
  string: Type.STRING,
  integer: Type.INTEGER,
  number: Type.NUMBER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

function toGeminiSchema(
  schema: OpenApiSchema,
  components: OpenApiComponents,
  descriptionOverride?: string,
): Schema {
  const resolved = resolveRef(schema, components);
  const geminiType = OPENAPI_TO_GEMINI_TYPE[resolved.type ?? 'string'] ?? Type.STRING;

  const result: Record<string, unknown> = { type: geminiType };

  const desc = descriptionOverride ?? resolved.description ?? '';
  if (desc) result.description = desc;

  if (resolved.enum) result.enum = resolved.enum;

  if (resolved.type === 'array' && resolved.items) {
    result.items = toGeminiSchema(resolveRef(resolved.items, components), components);
  }

  if (resolved.type === 'object' && resolved.properties) {
    const nested: Record<string, Schema> = {};
    for (const [key, val] of Object.entries(resolved.properties)) {
      nested[key] = toGeminiSchema(val, components);
    }
    result.properties = nested;
    if (resolved.required) result.required = resolved.required;
  }

  return result as unknown as Schema;
}

// ─── OpenApiToolset ──────────────────────────────────────────────────────────

/**
 * An ADK BaseToolset that reads an OpenAPI 3.x document and generates a
 * FunctionTool for every operation. Each tool's execute handler makes an
 * HTTP call to the live API server so the LLM can drive real actions.
 */
export class OpenApiToolset extends BaseToolset {
  private readonly _tools: FunctionTool[];

  constructor(
    private readonly swaggerDoc: OpenApiDocument,
    private readonly baseUrl: string,
  ) {
    super(() => true);
    this._tools = this.buildTools();
  }
  //api 의 종류 확인 후 툴 생성
  private buildTools(): FunctionTool[] {
    const tools: FunctionTool[] = [];
    const paths = this.swaggerDoc.paths ?? {};
    const components = this.swaggerDoc.components ?? {};

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        if (!operation?.operationId) continue;

        const tool = this.createFunctionTool(path, method, operation, components);
        if (tool) tools.push(tool);
      }
    }
    return tools;
  }

  private createFunctionTool(
    path: string,
    method: string,
    operation: OpenApiOperation,
    components: OpenApiComponents,
  ): FunctionTool | null {
    const { operationId, summary, description, parameters = [], requestBody } = operation;
    if (!operationId) return null;

    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    // Track where each param lives so the execute handler can route it correctly
    const paramMeta: Record<string, { in: string }> = {};

    // Path / query parameters
    for (const param of parameters) {
      const schema = resolveRef(param.schema ?? {}, components);
      properties[param.name] = toGeminiSchema(schema, components, param.description);
      paramMeta[param.name] = { in: param.in };
      if (param.required) required.push(param.name);
    }

    // Request body — flatten top-level properties into the tool parameters
    const bodyParamNames: string[] = [];
    if (requestBody) {
      const resolvedBody = resolveRef(
        requestBody as unknown as OpenApiSchema,
        components,
      ) as unknown as OpenApiRequestBody;
      const bodySchema = resolvedBody.content?.['application/json']?.schema;
      if (bodySchema) {
        const resolved = resolveRef(bodySchema, components);
        for (const [propName, propSchema] of Object.entries(resolved.properties ?? {})) {
          properties[propName] = toGeminiSchema(resolveRef(propSchema, components), components);
          bodyParamNames.push(propName);
        }
        if (Array.isArray(resolved.required)) required.push(...resolved.required);
      }
    }

    const parametersSchema: Schema = {
      type: Type.OBJECT,
      properties,
      ...(required.length > 0 ? { required } : {}),
    } as unknown as Schema;

    // Capture all closure variables by value
    const capturedBaseUrl = this.baseUrl;
    const capturedMethod = method.toUpperCase();
    const capturedPath = path;
    const capturedParamMeta = { ...paramMeta };
    const capturedBodyParamNames = [...bodyParamNames];

    return new FunctionTool({
      name: operationId,
      description: summary ?? description ?? '',
      parameters: parametersSchema,
      execute: async (input: unknown) => {
        const params = (input ?? {}) as Record<string, unknown>;

        // 1. Substitute path parameters
        let resolvedPath = capturedPath;
        for (const [name, meta] of Object.entries(capturedParamMeta)) {
          if (meta.in === 'path' && params[name] !== undefined) {
            resolvedPath = resolvedPath.replace(`{${name}}`, String(params[name]));
          }
        }

        // 2. Build query string
        const qs = new URLSearchParams();
        for (const [name, meta] of Object.entries(capturedParamMeta)) {
          if (meta.in === 'query' && params[name] !== undefined) {
            const val = params[name];
            if (Array.isArray(val)) {
              (val as unknown[]).forEach((v) => qs.append(name, String(v)));
            } else {
              qs.set(name, String(val));
            }
          }
        }
        const queryString = qs.toString();
        const url = `${capturedBaseUrl}${resolvedPath}${queryString ? `?${queryString}` : ''}`;

        // 3. Build JSON request body
        let body: string | undefined;
        if (capturedBodyParamNames.length > 0) {
          const bodyObj: Record<string, unknown> = {};
          for (const name of capturedBodyParamNames) {
            if (params[name] !== undefined) bodyObj[name] = params[name];
          }
          body = JSON.stringify(bodyObj);
        }

        try {
          const response = await fetch(url, {
            method: capturedMethod,
            headers: body ? { 'Content-Type': 'application/json' } : {},
            body,
          });

          if (!response.ok) {
            return { error: `HTTP ${response.status}`, message: await response.text() };
          }
          return (await response.json()) as unknown;
        } catch (err) {
          return { error: 'Request failed', message: String(err) };
        }
      },
    });
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (!context) return [...this._tools];
    return this._tools.filter((tool) => this.isToolSelected(tool, context));
  }

  async close(): Promise<void> {
    // No external connections to release
  }

  get toolCount(): number {
    return this._tools.length;
  }
}
