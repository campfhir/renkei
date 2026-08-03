import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@/lib/db';
import { getJiraGrant } from '@/lib/tenant-operations';
import { recordSession } from '@/lib/audit';
import { createLogger } from '@campfhir/bored-logs';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: {
      name: string;
    };
    assignee: {
      displayName: string;
    } | null;
    created: string;
    updated: string;
  };
}

interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

interface MCPCapabilities {
  resources: {
    listChanged?: boolean;
  };
}

interface MCPToolResult {
  type: 'text' | 'image' | 'resource';
  text?: string;
  url?: string;
  data?: string;
  mimeType?: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();

  try {
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Get the first Jira grant for this tenant (MVP: single user)
    const grants = await db
      .selectFrom('atlassian_grants')
      .select(['account_id'])
      .where('tenant_id', '=', tenantId)
      .limit(1)
      .execute();

    if (grants.length === 0) {
      return NextResponse.json(
        {
          error: 'No Jira grant configured',
          message: 'Please connect your Jira instance first',
        },
        { status: 400 }
      );
    }

    const grant = await getJiraGrant(tenantId, grants[0].account_id);
    if (!grant) {
      return NextResponse.json({ error: 'Failed to retrieve Jira grant' }, { status: 500 });
    }

    // Initialize MCP server response
    const mcp: any = {
      protocolVersion: '2024-11-05',
      capabilities: {
        resources: {},
      } as MCPCapabilities,
      resources: [] as MCPResource[],
      tools: [
        {
          name: 'list_issues',
          description: 'List all Jira issues accessible to this tenant',
          inputSchema: {
            type: 'object',
            properties: {
              jql: {
                type: 'string',
                description: 'JQL query to filter issues (optional)',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results (default: 50)',
              },
            },
          },
        },
        {
          name: 'get_issue',
          description: 'Get details for a specific Jira issue',
          inputSchema: {
            type: 'object',
            properties: {
              issueKey: {
                type: 'string',
                description: 'The issue key (e.g., PROJ-123)',
              },
            },
            required: ['issueKey'],
          },
        },
        {
          name: 'get_boards',
          description: 'List Jira boards available to this tenant',
          inputSchema: {
            type: 'object',
            properties: {
              maxResults: {
                type: 'number',
                description: 'Maximum number of results (default: 50)',
              },
            },
          },
        },
      ],
    };

    // Add resources for each issue
    mcp.resources.push({
      uri: 'jira://issues',
      name: 'Jira Issues',
      description: 'Access to all Jira issues in this tenant',
      mimeType: 'application/json',
    });

    console.log(`[MCP ${tenantId}] Serving endpoint for ${grant.displayName}`);

    return NextResponse.json(mcp);
  } catch (error) {
    console.error('MCP endpoint error:', error);
    return NextResponse.json({ error: 'Failed to initialize MCP server' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
) {
  const { tenantId } = await params;
  const db = getDatabase();
  const userAgent = request.headers.get('user-agent') || undefined;
  const ipAddress = request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
                   request.headers.get('x-real-ip') ||
                   undefined;

  try {
    const body = await request.json();
    const { method, params: toolParams } = body;

    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // Get Jira grant
    const grants = await db
      .selectFrom('atlassian_grants')
      .select(['account_id'])
      .where('tenant_id', '=', tenantId)
      .limit(1)
      .execute();

    if (grants.length === 0) {
      return NextResponse.json(
        { error: 'No Jira grant configured' },
        { status: 400 }
      );
    }

    const accountId = grants[0].account_id;
    const grant = await getJiraGrant(tenantId, accountId);
    if (!grant) {
      return NextResponse.json({ error: 'Failed to retrieve Jira grant' }, { status: 500 });
    }

    // Record session
    await recordSession({
      tenantId,
      accountId,
      userAgent,
      ipAddress,
    });

    let result: MCPToolResult | null = null;
    let toolError: string | undefined;

    // Route to appropriate MCP tool handler
    try {
      if (method === 'list_issues') {
        result = await handleListIssues(grant, toolParams);
      } else if (method === 'get_issue') {
        result = await handleGetIssue(grant, toolParams);
      } else if (method === 'get_boards') {
        result = await handleGetBoards(grant, toolParams);
      } else {
        toolError = `Unknown method: ${method}`;
      }

      if (!result && !toolError) {
        toolError = 'Failed to process request';
      }
    } catch (toolErr) {
      toolError = toolErr instanceof Error ? toolErr.message : 'Unknown error';
    }

    // Log tool call with bored-logs
    const logger = createLogger();
    if (toolError) {
      logger.error('[mcp:{tenantId}] Tool error: {method}', {
        tenantId,
        method,
        accountId,
        userAgent,
        ipAddress,
        status: 'failure',
        error: toolError,
      });
    } else {
      logger.info('[mcp:{tenantId}] Tool call: {method}', {
        tenantId,
        method,
        accountId,
        userAgent,
        ipAddress,
        status: 'success',
      });
    }

    if (toolError) {
      return NextResponse.json({ error: toolError }, { status: 400 });
    }

    console.log(`[MCP ${tenantId}] Tool executed: ${method}`);

    return NextResponse.json({
      type: 'tool_result',
      isError: false,
      content: [result],
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('MCP tool execution error:', error);

    // Try to log the error with bored-logs
    try {
      const body = await request.json().catch(() => ({}));
      const grants = await db
        .selectFrom('atlassian_grants')
        .select(['account_id'])
        .where('tenant_id', '=', tenantId)
        .limit(1)
        .execute();

      if (grants.length > 0) {
        const logger = createLogger();
        logger.error('[mcp:{tenantId}] Tool error: {method}', {
          tenantId,
          method: body.method || 'unknown',
          accountId: grants[0].account_id,
          userAgent,
          ipAddress,
          status: 'failure',
          error: errorMsg,
        });
      }
    } catch {
      // Silently fail logging
    }

    return NextResponse.json(
      {
        type: 'tool_result',
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${errorMsg}`,
          },
        ],
      },
      { status: 500 }
    );
  }
}

async function handleListIssues(grant: any, params: any): Promise<MCPToolResult | null> {
  try {
    const jql = params?.jql || 'order by updated DESC';
    const maxResults = params?.maxResults || 50;

    const response = await fetch(
      `${grant.siteUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}`,
      {
        headers: {
          Authorization: `Bearer ${grant.accessToken}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Jira API error: ${response.statusText}`);
    }

    const data = await response.json();
    const issues = data.issues || [];

    const formatted = issues
      .map((issue: JiraIssue) => ({
        key: issue.key,
        summary: issue.fields.summary,
        status: issue.fields.status.name,
        assignee: issue.fields.assignee?.displayName || 'Unassigned',
        updated: issue.fields.updated,
      }))
      .sort(
        (a: any, b: any) =>
          new Date(b.updated).getTime() - new Date(a.updated).getTime()
      );

    return {
      type: 'text',
      text: JSON.stringify(
        {
          total: data.total,
          count: issues.length,
          issues: formatted,
        },
        null,
        2
      ),
    };
  } catch (error) {
    return {
      type: 'text',
      text: `Error fetching issues: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function handleGetIssue(grant: any, params: any): Promise<MCPToolResult | null> {
  try {
    if (!params?.issueKey) {
      return {
        type: 'text',
        text: 'Error: issueKey parameter required',
      };
    }

    const response = await fetch(`${grant.siteUrl}/rest/api/3/issue/${params.issueKey}`, {
      headers: {
        Authorization: `Bearer ${grant.accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Jira API error: ${response.statusText}`);
    }

    const issue = await response.json();

    return {
      type: 'text',
      text: JSON.stringify(
        {
          key: issue.key,
          summary: issue.fields.summary,
          description: issue.fields.description || 'No description',
          status: issue.fields.status.name,
          assignee: issue.fields.assignee?.displayName || 'Unassigned',
          created: issue.fields.created,
          updated: issue.fields.updated,
        },
        null,
        2
      ),
    };
  } catch (error) {
    return {
      type: 'text',
      text: `Error fetching issue: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function handleGetBoards(grant: any, params: any): Promise<MCPToolResult | null> {
  try {
    const maxResults = params?.maxResults || 50;

    const response = await fetch(
      `${grant.siteUrl}/rest/api/3/boards?maxResults=${maxResults}`,
      {
        headers: {
          Authorization: `Bearer ${grant.accessToken}`,
          Accept: 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Jira API error: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      type: 'text',
      text: JSON.stringify(
        {
          total: data.maxResults,
          boards: (data.values || []).map((board: any) => ({
            id: board.id,
            name: board.name,
            type: board.type,
          })),
        },
        null,
        2
      ),
    };
  } catch (error) {
    return {
      type: 'text',
      text: `Error fetching boards: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
