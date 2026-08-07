'use client';

// Client-side re-exports of bored-logs UI components
// This file isolates server-only imports (PostgresAdapter, pg) from client components

export {
  LogTable,
  LogSearchBar,
  LogLevelFilter,
  LogDateRangePicker,
  LogCard,
  PurgeLogsDialog,
  LogTableRow,
  LogTableRowExpanded,
  LogTableRowGroup,
  LogSearchSyntaxHelp,
  formatTimestamp,
  DEFAULT_QUICK_RANGES,
} from '@campfhir/bored-logs/components';
export type {
  LogTableProps,
  LogSearchBarProps,
  LogLevelFilterProps,
  LogDateRangePickerProps,
  LogCardProps,
  LogTableRowProps,
  LogTableRowExpandedProps,
  LogTableRowGroupProps,
  ExtraColumn,
  LogCardField,
  LogDateRange,
  QuickRange,
  SortState,
  FilterExpr,
  LogQueryToken,
} from '@campfhir/bored-logs/components';
