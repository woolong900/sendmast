import { useId, type SVGProps } from 'react';

/**
 * SendMast logo mark — mast + billowing sail with an envelope-flap V cut out
 * of the sail (so the V always shows whatever is behind the SVG).
 *
 * Usage: drop inside any colored container; the mast & sail render with
 * `currentColor`. The V is masked out, not painted, so it adapts to the
 * parent background.
 *
 *   <div className="bg-primary text-primary-foreground">
 *     <BrandLogo className="size-4" />
 *   </div>
 */
export function BrandLogo(props: SVGProps<SVGSVGElement>) {
  const maskId = `sendmast-mask-${useId()}`;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <defs>
        <mask id={maskId}>
          <rect width="24" height="24" fill="white" />
          <path
            d="M8.5 7.5 L14 12 L8.5 16.5"
            stroke="black"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </mask>
      </defs>
      <path d="M6.5 3 V21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path
        d="M7 4 Q 19 7 21 12 Q 19 17 7 20 Z"
        fill="currentColor"
        mask={`url(#${maskId})`}
      />
    </svg>
  );
}
