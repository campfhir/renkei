/**
 * The generated half of the mirth_* surface: one named tool per entry of
 * `MIRTH_OPERATIONS` (packages/connector-mirth/src/operations.ts), each
 * with an input schema built from the operation's own path, query and
 * body specification — so `mirth_get_user` takes `userIdOrName`,
 * `mirth_delete_message` takes `channelId`, `messageId`, `metaDataId`,
 * and a wrong type is a validation error before anything is sent. This
 * is what covers the whole REST API without a generic "issue a request"
 * tool: every route is a tool of its own, with native-looking arguments.
 *
 * What the generated tools share with the curated ones in index.ts is the
 * runtime handed in here — the same `call` (worker client + phrased
 * refusals), the same per-instance exposure gate, the same cards — so a
 * generated tool is gated and reported exactly like a hand-written one.
 * Destructive operations become a `_preview` / `_confirm` pair on the
 * shared issue-preview card, the fileshare-delete discipline.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { MIRTH_OPERATIONS, fillPath, textOf } from '@renkei/connector-mirth';
import type {
  BodySpec,
  OperationKind,
  OperationSpec,
  ParamSpec,
  ParamType,
} from '@renkei/connector-mirth';
import type { MirthApiRequest, WireApiResponse } from '@/lib/mirth/service-client';
import {
  APP_ONLY_META,
  ISSUE_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';

/** What index.ts lends the generated tools. */
export interface OperationRuntime {
  call(
    instanceId: string,
    what: string,
    request: MirthApiRequest
  ): Promise<{ ok: true; response: WireApiResponse } | { ok: false; message: string }>;
  exposureRefusal(instanceId: string, need: 'write' | 'destructive'): Promise<string | null>;
  instanceName(instanceId: string): Promise<string>;
  maxChars: number;
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: true;
  structuredContent?: Record<string, unknown>;
};

const text = (value: string): ToolResult => ({ content: [{ type: 'text' as const, text: value }] });
const errText = (value: string): ToolResult => ({
  content: [{ type: 'text' as const, text: value }],
  isError: true as const,
});

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n…[truncated at ${maxChars} of ${value.length} characters]`;
}

/** The zod schema for one parameter type. */
function schemaFor(type: ParamType): z.ZodTypeAny {
  if (typeof type === 'object') {
    return type.multiple ? z.array(z.enum(type.enum)) : z.enum(type.enum);
  }
  switch (type) {
    case 'string':
      return z.string().min(1);
    case 'int':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'string[]':
      return z.array(z.string().min(1));
    case 'int[]':
      return z.array(z.number().int());
    case 'iso-date':
      return z.string().min(1);
  }
}

function fieldFor(param: ParamSpec): z.ZodTypeAny {
  const base = schemaFor(param.type).describe(
    param.type === 'iso-date' ? `${param.description} ISO 8601.` : param.description
  );
  return param.required ? base : base.optional();
}

/** The input schema of one generated tool: instanceId, then the operation's own fields. */
export function inputSchemaFor(
  operation: OperationSpec
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {
    instanceId: z.string().uuid().describe('From mirth_list_instances.'),
  };
  for (const param of operation.params) shape[param.name] = fieldFor(param);
  const body = operation.body;
  if (body) {
    if (body.kind === 'xml' || body.kind === 'text') {
      const field = z.string().describe(body.description);
      shape[body.name] = body.required === false ? field.optional() : field;
    } else if (body.kind === 'form') {
      for (const field of body.fields) shape[field.name] = fieldFor(field);
    } else if (body.kind === 'multipart') {
      for (const part of body.parts) {
        const field = z.string().describe(part.description);
        shape[part.name] = part.required ? field : field.optional();
      }
    }
  }
  return z.object(shape);
}

/** A query value the worker forwards, from a validated argument. */
function queryValue(value: unknown): string | number | boolean | string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    const items = value.map(String);
    return items.length ? items : undefined;
  }
  return undefined;
}

/** A multipart/form-data body of XML parts, built by hand — no dependency needed. */
export function multipartBody(
  parts: { name: string; value: string }[],
  boundary: string
): { body: string; contentType: string } {
  const lines: string[] = [];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    lines.push(`Content-Disposition: form-data; name="${part.name}"`);
    lines.push('Content-Type: application/xml');
    lines.push('');
    lines.push(part.value);
  }
  lines.push(`--${boundary}--`);
  lines.push('');
  return { body: lines.join('\r\n'), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Everything the worker needs for one operation, from validated arguments. */
export function requestFor(
  operation: OperationSpec,
  args: Record<string, unknown>
): { ok: true; request: MirthApiRequest } | { ok: false; error: string } {
  const pathValues: Record<string, string | number> = {};
  const query: NonNullable<MirthApiRequest['query']> = {};
  for (const param of operation.params) {
    const value = args[param.name];
    if (param.in === 'path') {
      if (value === undefined || value === null || value === '') {
        return { ok: false, error: `${param.name} is required.` };
      }
      pathValues[param.name] = typeof value === 'number' ? value : String(value);
      continue;
    }
    const forwarded = queryValue(value);
    if (forwarded === undefined) {
      if (param.required) return { ok: false, error: `${param.name} is required.` };
      continue;
    }
    query[param.name] = forwarded;
  }

  const request: MirthApiRequest = {
    method: operation.method,
    path: fillPath(operation.path, pathValues),
    ...(Object.keys(query).length ? { query } : {}),
    ...(operation.accept ? { accept: operation.accept } : {}),
  };

  const body = operation.body;
  if (body) {
    if (body.kind === 'xml' || body.kind === 'text') {
      const value = typeof args[body.name] === 'string' ? String(args[body.name]) : '';
      if (!value.trim()) {
        if (body.required !== false) return { ok: false, error: `${body.name} is required.` };
      } else {
        request.body = value;
        request.contentType = body.kind === 'xml' ? 'application/xml' : 'text/plain';
      }
    } else if (body.kind === 'form') {
      const form = new URLSearchParams();
      for (const field of body.fields) {
        const value = queryValue(args[field.name]);
        if (value === undefined) {
          if (field.required) return { ok: false, error: `${field.name} is required.` };
          continue;
        }
        for (const item of Array.isArray(value) ? value : [String(value)])
          form.append(field.name, item);
      }
      request.body = form.toString();
      request.contentType = 'application/x-www-form-urlencoded';
    } else if (body.kind === 'multipart') {
      const parts: { name: string; value: string }[] = [];
      for (const part of body.parts) {
        const value = typeof args[part.name] === 'string' ? String(args[part.name]) : '';
        if (!value.trim()) {
          if (part.required) return { ok: false, error: `${part.name} is required.` };
          continue;
        }
        parts.push({ name: part.name, value });
      }
      const built = multipartBody(parts, `renkei-${newPreviewId()}`);
      request.body = built.body;
      request.contentType = built.contentType;
    }
  }
  return { ok: true, request };
}

function parseJson(body: string): unknown {
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/** Phrase a successful answer: pretty JSON when Mirth spoke JSON, else the text. */
function phrase(response: WireApiResponse, maxChars: number): string {
  if (!response.body.trim()) return `Done (Mirth answered ${response.status}).`;
  const json = response.contentType?.includes('json') ? parseJson(response.body) : null;
  if (json !== null && typeof json !== 'string') {
    return clip(JSON.stringify(json, null, 2), maxChars);
  }
  return clip(response.body, maxChars);
}

function titleFor(operation: OperationSpec): string {
  return `Mirth · ${operation.kind === 'read' ? 'Read' : 'Act'} — ${operation.title}`;
}

function descriptionFor(operation: OperationSpec): string {
  const note =
    operation.kind === 'act'
      ? ' Requires act tools enabled for the instance on the Connectors page.'
      : operation.kind === 'destructive'
        ? ' Permanent: the user confirms on a card. Requires destructive operations enabled for the instance on the Connectors page.'
        : '';
  return `${operation.description}${note}`;
}

const BODY_PREVIEW_CHARS = 800;

/** What a destructive card shows: the request, every argument given, the body. */
function cardFields(
  operation: OperationSpec,
  args: Record<string, unknown>,
  instanceName: string
): { label: string; value: string }[] {
  const fields = [
    { label: 'Instance', value: instanceName },
    { label: 'Operation', value: `${operation.method} /api${operation.path}` },
  ];
  for (const param of operation.params) {
    const value = args[param.name];
    if (value === undefined || value === null || value === '') continue;
    fields.push({
      label: param.name,
      value: Array.isArray(value) ? value.map(String).join(', ') : textOf(value),
    });
  }
  const body = operation.body;
  const bodyNames =
    body === undefined
      ? []
      : body.kind === 'form'
        ? body.fields.map((field) => field.name)
        : body.kind === 'multipart'
          ? body.parts.map((part) => part.name)
          : [body.name];
  for (const name of bodyNames) {
    const value = args[name];
    if (typeof value === 'string' && value.trim())
      fields.push({ label: name, value: clip(value, BODY_PREVIEW_CHARS) });
    else if (Array.isArray(value))
      fields.push({ label: name, value: value.map(String).join(', ') });
    else if (value !== undefined && value !== null && value !== '')
      fields.push({ label: name, value: textOf(value) });
  }
  fields.push({ label: 'Undo', value: 'None — Mirth applies it immediately' });
  return fields;
}

/**
 * Register the generated tools of one kind. index.ts calls this once per
 * kind at the point where that kind's exposure has been established, so
 * the registered list mirrors the caller's exposure like the curated
 * tools do.
 */
export function registerOperationTools(
  server: McpServer,
  runtime: OperationRuntime,
  kind: OperationKind,
  operations: readonly OperationSpec[] = MIRTH_OPERATIONS
): void {
  for (const operation of operations.filter((candidate) => candidate.kind === kind)) {
    const name = `mirth_${operation.tool}`;
    const inputSchema = inputSchemaFor(operation);
    const need: 'write' | 'destructive' | null =
      operation.kind === 'destructive' ? 'destructive' : operation.kind === 'act' ? 'write' : null;

    const execute = async (args: Record<string, unknown>): Promise<ToolResult> => {
      const instanceId = typeof args.instanceId === 'string' ? args.instanceId : '';
      if (need) {
        const refusal = await runtime.exposureRefusal(instanceId, need);
        if (refusal) return errText(refusal);
      }
      const built = requestFor(operation, args);
      if (!built.ok) return errText(built.error);
      const answered = await runtime.call(instanceId, operation.title.toLowerCase(), built.request);
      if (!answered.ok) return errText(answered.message);
      return text(phrase(answered.response, runtime.maxChars));
    };

    if (operation.kind !== 'destructive') {
      server.registerTool(
        name,
        {
          title: titleFor(operation),
          description: descriptionFor(operation),
          annotations: { readOnlyHint: operation.kind === 'read' },
          inputSchema,
        },
        execute
      );
      continue;
    }

    server.registerTool(
      `${name}_preview`,
      {
        title: `${titleFor(operation)} (preview)`,
        description:
          `Show the user an interactive card to confirm or cancel: ${descriptionFor(operation)} ` +
          `This is the only way to run it here.`,
        annotations: { readOnlyHint: false },
        _meta: previewToolMeta(ISSUE_PREVIEW_URI),
        inputSchema,
      },
      async (args: Record<string, unknown>) => {
        const instanceId = typeof args.instanceId === 'string' ? args.instanceId : '';
        const refusal = await runtime.exposureRefusal(instanceId, 'destructive');
        if (refusal) return errText(refusal);
        const built = requestFor(operation, args);
        if (!built.ok) return errText(built.error);
        const instanceName = await runtime.instanceName(instanceId);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${operation.title} is awaiting the user's decision on the preview card. Do not do ` +
                `it another way and do not repeat its contents in your reply; the user confirms or ` +
                `cancels from the card. If no card appeared in this client, ask the user how to proceed.`,
            },
          ],
          structuredContent: {
            kind: 'issue',
            previewId: newPreviewId(),
            title: operation.title,
            subtitle: `${instanceName} · ${operation.method} /api${built.request.path}`,
            confirmTool: `${name}_confirm`,
            confirmLabel: 'Run it',
            confirmArgs: args,
            fields: cardFields(operation, args, instanceName),
          },
        };
      }
    );

    server.registerTool(
      `${name}_confirm`,
      {
        title: `${titleFor(operation)} (confirmed)`,
        description: `Run the operation the user confirmed on the preview card. ${confirmGuard(`${name}_preview`)}`,
        annotations: { readOnlyHint: false },
        _meta: APP_ONLY_META,
        inputSchema,
      },
      execute
    );
  }
}

/** Sample arguments satisfying an operation's required fields — for tests. */
export function sampleArgsFor(operation: OperationSpec): Record<string, unknown> {
  const args: Record<string, unknown> = { instanceId: '11111111-2222-4333-8444-555555555555' };
  const sample = (param: ParamSpec): unknown => {
    if (typeof param.type === 'object')
      return param.type.multiple ? [param.type.enum[0]] : param.type.enum[0];
    switch (param.type) {
      case 'int':
        return 1;
      case 'boolean':
        return true;
      case 'string[]':
        return ['x'];
      case 'int[]':
        return [1];
      default:
        return 'x';
    }
  };
  for (const param of operation.params) if (param.required) args[param.name] = sample(param);
  const body: BodySpec | undefined = operation.body;
  if (body) {
    if (body.kind === 'xml' || body.kind === 'text') args[body.name] = '<x/>';
    else if (body.kind === 'form') {
      for (const field of body.fields) if (field.required) args[field.name] = sample(field);
    } else if (body.kind === 'multipart') {
      for (const part of body.parts) if (part.required) args[part.name] = '<x/>';
    }
  }
  return args;
}
