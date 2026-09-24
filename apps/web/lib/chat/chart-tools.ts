/**
 * chat_write_chart — the model's way to hand the person a chart or a
 * diagram: a bar or line chart, a pie, a Gantt plan, a flowchart, a
 * sequence diagram. The model writes Mermaid text (never bytes), the
 * sandbox worker draws it in its own headless Chromium
 * (apps/worker-sandbox/src/charts.ts) as a PNG, an SVG or a one-page PDF,
 * and the bytes come back through `_meta.renkeiDocuments` — the same door
 * chat_write_file uses — so the chart lands under the chat's Artifacts
 * for download or copying to a network share. The org agent's equivalent
 * is sandbox_render_chart, which stages the same render in the scratch
 * space instead.
 *
 * Offered only where the organization has a store to keep files in AND a
 * sandbox worker with charts enabled (chat-local-tools.ts), so the model
 * is never given a verb that can only fail.
 */

import {
  CHART_SOURCE_MAX_CHARS,
  chartFilename,
  parseChartRequest,
} from '@renkei/connector-sandbox';
import { clientFailure, sbChartRender } from '@renkei/sandbox-client';
import { CHART_SYNTAX_HINT } from '@/lib/mcp-tools/sandbox/charts';
import { checkFilename } from './file-tools';
import { errorResult, textResult, type LocalTool } from './local-tools';

const KEPT_LINE =
  'It is under this chat’s Artifacts, where the person can download it or copy it to a network share; tell them so, and describe what the chart shows in a sentence rather than repeating its data.';

export function chartTools(): LocalTool[] {
  return [
    {
      def: {
        name: 'chat_write_chart',
        description:
          'Draw a chart or diagram for the person to keep — a bar or line chart, a pie, a Gantt ' +
          'plan, a flowchart, a sequence or state diagram, a mind map, a timeline — from Mermaid ' +
          'text you write, rendered to a PNG image (default), an SVG, or a one-page PDF. It ' +
          'appears under this chat’s Artifacts like a file from chat_write_file. Write the ' +
          'diagram as text, never bytes or base64. ' +
          CHART_SYNTAX_HINT,
        inputSchema: {
          type: 'object',
          properties: {
            source: {
              type: 'string',
              description: `The complete Mermaid diagram text (at most ${CHART_SOURCE_MAX_CHARS} characters).`,
            },
            filename: {
              type: 'string',
              description:
                'The name to save as; the format’s extension is added (sales, plan.png). A name, not a path. Default: chart.',
            },
            format: {
              type: 'string',
              enum: ['png', 'svg', 'pdf'],
              description: 'What to make: png (default), svg, or a one-page pdf.',
            },
            theme: {
              type: 'string',
              enum: ['default', 'neutral', 'dark', 'forest', 'base'],
              description: 'Mermaid theme (default: default). The source may set its own instead.',
            },
            background: {
              type: 'string',
              description: '"transparent" (png/svg) or a hex color such as #ffffff (default).',
            },
            scale: {
              type: 'integer',
              minimum: 1,
              maximum: 4,
              description: 'png only: device pixels per CSS pixel, 1–4 (default 2).',
            },
          },
          required: ['source'],
        },
      },
      async execute(input, context) {
        const parsed = parseChartRequest(input);
        if (!parsed.ok) return errorResult(parsed.message);
        const name = checkFilename(chartFilename(input.filename, parsed.request.format));
        if (!name.ok) return errorResult(name.reason);

        const rendered = await sbChartRender(
          { tenantId: context.tenantId, subject: context.subject },
          {
            source: parsed.request.source,
            format: parsed.request.format,
            theme: parsed.request.theme,
            background: parsed.request.background,
            scale: parsed.request.scale,
          }
        );
        if (!rendered.ok) return errorResult(clientFailure(rendered.err).message);
        const { bytes, mediaType, width, height, diagramType } = rendered.val;
        return textResult(
          `Drew ${name.filename} (${mediaType}, ${bytes.byteLength} bytes, ${width}×${height} px, a ${diagramType} diagram). ${KEPT_LINE}`,
          {
            renkeiDocuments: [
              {
                mediaType,
                dataBase64: Buffer.from(bytes).toString('base64'),
                title: name.filename,
              },
            ],
            // The model wrote this; it does not need to read it back.
            renkeiDocumentsShown: false,
          }
        );
      },
    },
  ];
}
