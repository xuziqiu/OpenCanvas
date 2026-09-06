import { forwardRef, type SVGProps } from 'react';

export type ProductIconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & { size?: number };

function baseProps({ size = 16, className = '', ...props }: ProductIconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': props['aria-label'] ? undefined : true,
    focusable: false,
    className: `oc-icon ${className}`.trim(),
    ...props,
  };
}

/** The product-level whiteboard mark: three spatial panels, not a book. */
export const WhiteboardIcon = forwardRef<SVGSVGElement, ProductIconProps>((props, ref) => <svg ref={ref} {...baseProps(props)}>
  <path d="M3.75 6.4 9.1 4.6v13l-5.35 1.8z" />
  <path d="m9.1 4.6 5.8 1.8v13l-5.8-1.8z" />
  <path d="m14.9 6.4 5.35-1.8v13l-5.35 1.8z" />
</svg>);
WhiteboardIcon.displayName = 'WhiteboardIcon';

/** A Markdown card with a quiet title/body rhythm. */
export const CardIcon = forwardRef<SVGSVGElement, ProductIconProps>((props, ref) => <svg ref={ref} {...baseProps(props)}>
  <rect x="4" y="3.5" width="16" height="17" rx="2.75" />
  <path d="M7.5 8h7.75M7.5 11.5h9M7.5 15h6.25" />
</svg>);
CardIcon.displayName = 'CardIcon';

/** Create a new, independent card rather than a generic file. */
export const CardPlusIcon = forwardRef<SVGSVGElement, ProductIconProps>((props, ref) => <svg ref={ref} {...baseProps(props)}>
  <rect x="3.5" y="3.5" width="13.5" height="17" rx="2.75" />
  <path d="M7 8h6.5M7 11.5h5" />
  <path d="M19.25 13.5v7M15.75 17h7" />
</svg>);
CardPlusIcon.displayName = 'CardPlusIcon';

/** A semantic connector with two visible attachment endpoints. */
export const ConnectorIcon = forwardRef<SVGSVGElement, ProductIconProps>((props, ref) => <svg ref={ref} {...baseProps(props)}>
  <circle cx="5" cy="17" r="2" />
  <circle cx="19" cy="7" r="2" />
  <path d="M7 16.25c4.25-1.4 4-6.25 10-8.5" />
</svg>);
ConnectorIcon.displayName = 'ConnectorIcon';

/** Root spatial desktop containing several independently placed boards. */
export const DesktopIcon = forwardRef<SVGSVGElement, ProductIconProps>((props, ref) => <svg ref={ref} {...baseProps(props)}>
  <rect x="3.5" y="4" width="7" height="6" rx="1.5" />
  <rect x="13" y="3" width="7.5" height="8" rx="1.5" />
  <rect x="4.5" y="13" width="8.5" height="7" rx="1.5" />
  <rect x="15.5" y="14" width="4" height="5" rx="1.25" />
</svg>);
DesktopIcon.displayName = 'DesktopIcon';

/** A background section: four corners and its small title chip. */
export const SectionIcon = forwardRef<SVGSVGElement, ProductIconProps>((props, ref) => <svg ref={ref} {...baseProps(props)}>
  <path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
  <path d="M8 8h8" />
</svg>);
SectionIcon.displayName = 'SectionIcon';

/** The file dimension: one folder with a Markdown leaf. */
export const FilesIcon = forwardRef<SVGSVGElement, ProductIconProps>((props, ref) => <svg ref={ref} {...baseProps(props)}>
  <path d="M3.5 7.25V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7" />
  <path d="M4.5 10.5h6a1.5 1.5 0 0 1 1.5 1.5v6.5H4.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z" />
  <path d="M6.5 14h3M6.5 16.5h2" />
</svg>);
FilesIcon.displayName = 'FilesIcon';
