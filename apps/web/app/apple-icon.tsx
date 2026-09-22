import { ImageResponse } from 'next/og';

/**
 * iOS has no equivalent of `app/icon.svg`: home-screen and startup-screen
 * icons must be a raster the OS can composite (a rounded-square mask,
 * a icon a widget), so this generates one from the same mark and gradient
 * at the standard iPhone size instead of leaving iOS to screenshot the page.
 */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#ffffff',
      }}
    >
      <svg width="132" height="132" viewBox="80 -20 240 240">
        <defs>
          <linearGradient id="inf" x1="0" y1="0.15" x2="1" y2="0.85">
            <stop offset="0" stopColor="#5FE8E0" />
            <stop offset="0.5" stopColor="#2FC8F0" />
            <stop offset="1" stopColor="#2C7BE5" />
          </linearGradient>
        </defs>
        <path
          d="M100 100C100 40 160 40 200 100C240 160 300 160 300 100C300 40 240 40 200 100C160 160 100 160 100 100Z"
          fill="none"
          stroke="url(#inf)"
          strokeWidth="22"
          strokeLinecap="round"
        />
      </svg>
    </div>,
    size
  );
}
