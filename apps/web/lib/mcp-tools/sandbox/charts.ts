/**
 * sandbox_render_chart — a chart or diagram from Mermaid text the model
 * wrote, drawn by the sandbox worker's own headless Chromium
 * (apps/worker-sandbox/src/charts.ts) and staged in the caller's scratch
 * space as a PNG, an SVG or a PDF. The same door as sandbox_render_document:
 * the model writes text, the worker produces the bytes, and from the
 * scratch space the file goes wherever a *_request_*_upload tool reaches
 * with sandbox_send_to_upload. The chat's own chat_write_chart
 * (apps/web/lib/chat/chart-tools.ts) renders the same way and attaches
 * the result to the chat directly instead.
 *
 * Registered only where the deployment renders charts
 * (SANDBOX_CHARTS_ENABLED on the worker and here) — closed, never open.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  CHART_KINDS_HINT,
  CHART_SOURCE_MAX_CHARS,
  parseChartRequest,
  chartFilename,
  validateFilename,
} from '@renkei/connector-sandbox';
import type { MCPToolContext } from '../common';
import { errText, fileLine, targetOf, textResult } from './shared';
import { sbChartStage, clientFailure } from '@/lib/sandbox/service-client';

/** The one line both chart tools use to say what Mermaid text looks like. */
export const CHART_SYNTAX_HINT =
  'The source is Mermaid diagram text: the first line names the kind — ' +
  CHART_KINDS_HINT +
  ' — and the rest describes it. A bar or line chart: ' +
  '"xychart-beta\\n  title \\"Sales\\"\\n  x-axis [Q1, Q2, Q3]\\n  y-axis \\"k$\\" 0 --> 100\\n  bar [40, 65, 80]\\n  line [30, 60, 70]". ' +
  'A pie: "pie title Tickets\\n  \\"Open\\" : 42\\n  \\"Closed\\" : 58". ' +
  'A Gantt plan: "gantt\\n  dateFormat YYYY-MM-DD\\n  section Build\\n  Design :a1, 2026-10-01, 10d\\n  Implement :after a1, 20d". ' +
  'A flowchart: "flowchart LR\\n  A[Start] --> B{Ok?}\\n  B -- yes --> C[Ship]\\n  B -- no --> D[Fix] --> B". ' +
  'Quote labels that contain punctuation. A diagram Mermaid cannot parse is refused with its parse error (line and expected tokens): correct the text and call again.';

export function registerSandboxChartTools(server: McpServer, context: MCPToolContext): void {
  server.registerTool(
    'sandbox_render_chart',
    {
      title:
        'Sandbox · Act — Draw a chart or diagram from Mermaid text, staged in your scratch space',
      description:
        'Turn Mermaid text you write into a chart or diagram — a bar or line chart, a pie, a ' +
        'Gantt plan, a flowchart, a sequence or state diagram, a mind map, a timeline — rendered ' +
        'to a PNG image (default), an SVG, or a one-page PDF, and staged in your scratch space. ' +
        'From there, request an upload endpoint with the destination’s own *_request_*_upload ' +
        'tool (a SharePoint or OneDrive library, a Jira/JSM/Confluence attachment, a network ' +
        'share, OnBase) and complete it with sandbox_send_to_upload — no curl, no browser, no ' +
        'base64. ' +
        CHART_SYNTAX_HINT,
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        source: z
          .string()
          .min(1)
          .max(CHART_SOURCE_MAX_CHARS)
          .describe('The complete Mermaid diagram text, as written (never base64).'),
        format: z
          .enum(['png', 'svg', 'pdf'])
          .optional()
          .describe('What to make: png (default), svg, or a one-page pdf.'),
        theme: z
          .enum(['default', 'neutral', 'dark', 'forest', 'base'])
          .optional()
          .describe('Mermaid theme (default: default). The source may set its own instead.'),
        background: z
          .string()
          .max(16)
          .optional()
          .describe('"transparent" (png/svg) or a hex color such as #ffffff (default).'),
        scale: z
          .number()
          .int()
          .min(1)
          .max(4)
          .optional()
          .describe('png only: device pixels per CSS pixel, 1–4 (default 2, crisp on a slide).'),
        filename: z
          .string()
          .max(255)
          .optional()
          .describe('Name to stage the file as; the format’s extension is added (default chart).'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const target = targetOf(context);
      if (typeof target === 'string') return errText(target);

      const parsed = parseChartRequest(args);
      if (!parsed.ok) return errText(parsed.message);
      const named = validateFilename(chartFilename(args.filename, parsed.request.format));
      if (!named.ok) return errText('filename must be a name, not a path.');

      const staged = await sbChartStage(target, {
        source: parsed.request.source,
        format: parsed.request.format,
        theme: parsed.request.theme,
        background: parsed.request.background,
        scale: parsed.request.scale,
        filename: named.filename,
      });
      if (!staged.ok) return errText(clientFailure(staged.err).message);
      return textResult(
        `Staged ${fileLine(staged.val.file)} — a ${staged.val.diagramType} diagram, ` +
          `${staged.val.width}×${staged.val.height} px.\n` +
          'Next: request an upload endpoint with the destination’s own *_request_*_upload tool ' +
          '(e.g. sharepoint_request_document_upload), then call sandbox_send_to_upload with ' +
          'this fileId and that uploadId to move it there.'
      );
    }
  );
}
