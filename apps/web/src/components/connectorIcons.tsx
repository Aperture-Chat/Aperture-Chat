import type { ComponentType, ReactNode, SVGProps } from "react";

/**
 * Brand-shaped connector icons drawn in the platform's icon language
 * (24px grid, 2px currentColor strokes, round caps) so they read as part of
 * the product rather than pasted-in vendor logos. Signature-compatible with
 * lucide icons (`size` prop) so they can share render sites.
 */

export type ConnectorIconProps = SVGProps<SVGSVGElement> & { size?: number | string };
export type ConnectorIcon = ComponentType<ConnectorIconProps>;

function IconBase({ size = 24, children, ...rest }: ConnectorIconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** The Drive tri-segment triangle as a stroke wireframe. */
export function GoogleDriveIcon(props: ConnectorIconProps) {
  return (
    <IconBase {...props}>
      <path d="m12 10-6 10-3-5 6-10z" />
      <path d="M9 15h12l-3 5H6z" />
      <path d="m15 15-6-10h6l6 10z" />
    </IconBase>
  );
}

/** The full Microsoft cloud silhouette. */
export function OneDriveIcon(props: ConnectorIconProps) {
  return (
    <IconBase {...props}>
      <path d="M18 19H7a4.5 4.5 0 0 1-.84-8.92 5.5 5.5 0 0 1 10.32-2.4 5.75 5.75 0 0 1 1.52 11.32Z" />
    </IconBase>
  );
}

/** The SharePoint mark's cascade of three circles. */
export function SharePointIcon(props: ConnectorIconProps) {
  return (
    <IconBase {...props}>
      <circle cx="10" cy="8.5" r="5.5" />
      <circle cx="16" cy="14.5" r="4.5" />
      <circle cx="10.5" cy="18.5" r="3" />
    </IconBase>
  );
}

/** A cube, matching both the Box name and its content-cloud branding. */
export function BoxIcon(props: ConnectorIconProps) {
  return (
    <IconBase {...props}>
      <path d="m12 2 9 5v10l-9 5-9-5V7z" />
      <path d="m3 7 9 5 9-5" />
      <path d="M12 12v10" />
    </IconBase>
  );
}

/** A filed-documents folder for the iManage legal DMS. */
export function IManageIcon(props: ConnectorIconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path d="M7.5 11.5h9" />
      <path d="M7.5 15h5.5" />
    </IconBase>
  );
}
