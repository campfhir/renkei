import { ViewerSkeleton } from '@/components/skeleton';

/** The usage viewer: header, period pills, stat tiles, chart, table. */
export default function OrgUsageLoading() {
  return <ViewerSkeleton label="Loading organization usage…" />;
}
