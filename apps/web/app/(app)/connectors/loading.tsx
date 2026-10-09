import { LoadingRegion, SkeletonCard, SkeletonHeading } from '@/components/skeleton';

/** Connectors: the MCP endpoint card, then the two-column deck of connector cards. */
export default function ConnectorsLoading() {
  return (
    <LoadingRegion label="Loading connectors…" className="mx-auto max-w-6xl">
      <SkeletonHeading actions={1} />
      <div className="flex flex-col gap-6">
        <SkeletonCard lines={2} chips={0} />
        <div aria-hidden="true" className="-mb-6 lg:columns-2 lg:gap-6">
          {[3, 1, 2, 1, 2].map((lines, index) => (
            <div key={index} className="mb-6 break-inside-avoid">
              <SkeletonCard lines={lines} chips={2} />
            </div>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}
