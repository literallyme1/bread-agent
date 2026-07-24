import { BaseToolset, FunctionTool } from '@google/adk';
import type { BaseTool, ReadonlyContext } from '@google/adk';
import type { Schema } from '@google/genai';
import { Type } from '@google/genai';
import { chatContextStorage } from './chat-context';

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

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** OpenAPI 참조 스키마를 실제 컴포넌트 스키마로 변환한다. */
function resolveOpenApiSchema<T extends OpenApiSchema>(
  schema: T,
  components: OpenApiComponents,
): T {
  if (!schema?.$ref) return schema;
  const parts = schema.$ref.replace('#/', '').split('/');
  const root: Record<string, unknown> = { components };
  let current: unknown = root;
  for (const part of parts) {
    current = (current as Record<string, unknown>)?.[part];
    if (current === undefined) return schema;
  }
  return (current as T) ?? schema;
}

const OPENAPI_TO_GEMINI_TYPE: Record<string, Type> = {
  string: Type.STRING,
  integer: Type.INTEGER,
  number: Type.NUMBER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

/** OpenAPI 스키마를 Gemini Function Tool 입력 스키마로 변환한다. */
function convertToGeminiSchema(
  schema: OpenApiSchema,
  components: OpenApiComponents,
  descriptionOverride?: string,
): Schema {
  const resolved = resolveOpenApiSchema(schema, components);
  const geminiType =
    OPENAPI_TO_GEMINI_TYPE[resolved.type ?? 'string'] ?? Type.STRING;

  const result: Record<string, unknown> = { type: geminiType };

  const desc = descriptionOverride ?? resolved.description ?? '';
  if (desc) result.description = desc;

  if (resolved.enum) result.enum = resolved.enum;

  if (resolved.type === 'array' && resolved.items) {
    result.items = convertToGeminiSchema(
      resolveOpenApiSchema(resolved.items, components),
      components,
    );
  }

  if (resolved.type === 'object' && resolved.properties) {
    const nested: Record<string, Schema> = {};
    for (const [key, val] of Object.entries(resolved.properties)) {
      nested[key] = convertToGeminiSchema(val, components);
    }
    result.properties = nested;
    if (resolved.required) result.required = resolved.required;
  }

  return result;
}

/** Function Tool 입력값을 URL 파라미터에 안전하게 직렬화한다. */
function serializeToolParameter(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  return JSON.stringify(value);
}

export class OpenApiToolset extends BaseToolset {
  private readonly _tools: FunctionTool[];

  constructor(
    private readonly swaggerDoc: OpenApiDocument,
    private readonly baseUrl: string,
    private readonly excludedOperations: Set<string> = new Set(),
  ) {
    super(() => true);
    this._tools = this.buildTools();
  }

  /** Swagger operation을 실행 가능한 Gemini Function Tool 목록으로 생성한다. */
  private buildTools(): FunctionTool[] {
    const tools: FunctionTool[] = [];
    const paths = this.swaggerDoc.paths ?? {};
    const components = this.swaggerDoc.components ?? {};

    for (const [path, pathItem] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        if (!operation?.operationId) continue;
        if (this.excludedOperations.has(operation.operationId)) continue;

        const tool = this.createApiFunctionTool(
          path,
          method,
          operation,
          components,
        );
        if (tool) tools.push(tool);
      }
    }
    return tools;
  }

  /** API operation의 파라미터와 HTTP 실행기를 하나의 Function Tool로 구성한다. */
  private createApiFunctionTool(
    path: string,
    method: string,
    operation: OpenApiOperation,
    components: OpenApiComponents,
  ): FunctionTool | null {
    const {
      operationId,
      summary,
      description,
      parameters = [],
      requestBody,
    } = operation;
    if (!operationId) return null;

    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    const paramMeta: Record<string, { in: string }> = {};

    for (const param of parameters) {
      if (param.in === 'header') continue;
      const schema = resolveOpenApiSchema(param.schema ?? {}, components);
      properties[param.name] = convertToGeminiSchema(
        schema,
        components,
        param.description,
      );
      paramMeta[param.name] = { in: param.in };
      if (param.required) required.push(param.name);
    }

    const bodyParamNames: string[] = [];
    if (requestBody) {
      const resolvedBody = resolveOpenApiSchema(requestBody, components);
      const bodySchema = resolvedBody.content?.['application/json']?.schema;
      if (bodySchema) {
        const resolved = resolveOpenApiSchema(bodySchema, components);
        for (const [propName, propSchema] of Object.entries(
          resolved.properties ?? {},
        )) {
          properties[propName] = convertToGeminiSchema(
            resolveOpenApiSchema(propSchema, components),
            components,
          );
          bodyParamNames.push(propName);
        }
        if (Array.isArray(resolved.required))
          required.push(...resolved.required);
      }
    }

    const parametersSchema: Schema = {
      type: Type.OBJECT,
      properties,
      ...(required.length > 0 ? { required } : {}),
    };

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

        let resolvedPath = capturedPath;
        for (const [name, meta] of Object.entries(capturedParamMeta)) {
          if (meta.in === 'path' && params[name] !== undefined) {
            resolvedPath = resolvedPath.replace(
              `{${name}}`,
              serializeToolParameter(params[name]),
            );
          }
        }

        const qs = new URLSearchParams();
        for (const [name, meta] of Object.entries(capturedParamMeta)) {
          if (meta.in === 'query' && params[name] !== undefined) {
            const val = params[name];
            if (Array.isArray(val)) {
              val.forEach((v) => qs.append(name, serializeToolParameter(v)));
            } else {
              qs.set(name, serializeToolParameter(val));
            }
          }
        }
        const queryString = qs.toString();
        const url = `${capturedBaseUrl}${resolvedPath}${queryString ? `?${queryString}` : ''}`;

        let body: string | undefined;
        if (capturedBodyParamNames.length > 0) {
          const bodyObj: Record<string, unknown> = {};
          for (const name of capturedBodyParamNames) {
            if (params[name] !== undefined) bodyObj[name] = params[name];
          }
          body = JSON.stringify(bodyObj);
        }

        try {
          const chatCtx = chatContextStorage.getStore();
          const requestHeaders: Record<string, string> = {};
          if (body) requestHeaders['Content-Type'] = 'application/json';
          if (chatCtx?.userId)
            requestHeaders['X-Chat-User-Id'] = chatCtx.userId;

          const response = await fetch(url, {
            method: capturedMethod,
            headers: requestHeaders,
            body,
          });

          if (!response.ok) {
            return {
              error: `HTTP ${response.status}`,
              message: await response.text(),
            };
          }
          return (await response.json()) as unknown;
        } catch (err) {
          return { error: 'Request failed', message: String(err) };
        }
      },
    });
  }

  /** 현재 실행 컨텍스트에서 허용된 Function Tool 목록을 반환한다. */
  getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const tools = context
      ? this._tools.filter((tool) => this.isToolSelected(tool, context))
      : [...this._tools];
    return Promise.resolve(tools);
  }

  /** Toolset 종료 시 정리 지점을 제공한다. */
  async close(): Promise<void> {}

  /** 자동 생성된 Function Tool 개수를 반환한다. */
  get toolCount(): number {
    return this._tools.length;
  }
}
