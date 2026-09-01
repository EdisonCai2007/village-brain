import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconFrame({ children, ...props }: IconProps) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" {...props}>
      {children}
    </svg>
  );
}

export function LandIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M2.8 18.8 8.2 9l2.1 3.2L13.7 5l7.5 13.8z" fill="none" />
      <path d="m6.4 12.2 1.8-3.1 1.9 2.9M11.5 9.6 13.7 5l2.5 4.7M4.8 18.8h14.4" fill="none" />
      <path d="M13.7 5 12 12l3.9-2.1" fill="none" />
    </IconFrame>
  );
}

export function WaterIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M3 7.5c2.7 0 2.7 1.8 5.4 1.8s2.7-1.8 5.4-1.8 2.7 1.8 5.4 1.8M3 12c2.7 0 2.7 1.8 5.4 1.8s2.7-1.8 5.4-1.8 2.7 1.8 5.4 1.8M3 16.5c2.7 0 2.7 1.8 5.4 1.8s2.7-1.8 5.4-1.8 2.7 1.8 5.4 1.8" fill="none" /></IconFrame>;
}

export function TotemIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M12 2.4 17.2 7.1 15.7 21H8.3L6.8 7.1z" />
      <path d="M12 2.8v18M8.2 20.7h7.6M8.9 7.4h6.2M9.7 11.5h4.6M10.2 15.7h3.6" fill="none" />
      <path d="M6.9 7.1 12 10.1l5.1-3" fill="none" />
    </IconFrame>
  );
}

export function FireIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path
        d="M13.2 2.1c-3.1 2.1-4.3 4.7-4.1 8.1-1.4-1.8-3.1-2.9-5.1-3.4 1.2 2.2 1.2 4.2.2 6.3-1.6 3.4.3 7.2 4.5 8.3 5.7 1.5 11.1-1.5 12.2-6.6.6-3.1-.4-6.2-3.1-9.1-.2 3-1 5-2.5 6.2.1-3.3-.6-6.5-2.1-9.8zM11.3 20c-2.2-.5-3.4-1.9-3.2-3.8.1-1.3.8-2.5 2.1-3.7.1 1.2.6 2.1 1.6 2.8.1-1.6.9-2.8 2.3-3.7.4 1.9.8 3.5 1.2 4.7.4 1.7-1.3 3.3-4 3.7z"
        fillRule="evenodd"
        clipRule="evenodd"
      />
    </IconFrame>
  );
}

export function TsunamiIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M3 18.5c2.7-6.8 7.5-10.6 14.5-11.3-3.5 1.3-4.9 3.5-4 6.4.9 2.7 4.5 3.3 6.8.8-.6 5.4-5.9 8-11.3 5.7-2-.9-3.9-1.4-6-1.6z" /><path d="M5 16.5c2.9-.4 5.2.1 7 1.4" fill="none" /></IconFrame>;
}

export function BanditsIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="6.4" r="3.3" />
      <path d="M7 21c.3-5.2 2-7.8 5-7.8s4.7 2.6 5 7.8z" />
      <path d="M8.3 9.2c1 .9 2.2 1.3 3.7 1.3s2.7-.4 3.7-1.3M8.4 4.8c.9-1.2 2.1-1.8 3.6-1.8s2.7.6 3.6 1.8M6.6 16.5l-2.4 2.2M17.4 16.5l2.4 2.2" fill="none" />
      <path d="M9.2 6.5h1.4M13.4 6.5h1.4M10.3 8.7c1.1.5 2.3.5 3.4 0" fill="none" />
    </IconFrame>
  );
}

export function EarthquakeIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M3 17h5l2-4 3 7 2-5h6M5 8h5l2-4 3 8 2-4h3" fill="none" /><path d="M12 2.5 10.5 8l2.5 2-2 5.2 3 6.3" fill="none" /></IconFrame>;
}

export function PlagueIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="12" cy="12" r="9.1" fill="none" />
      <circle cx="12" cy="12" r="1.55" />
      <path d="M9.8 9.7c-2-2.8-.9-5.7 2.2-6.9 3.1 1.2 4.2 4.1 2.2 6.9" fill="none" strokeWidth={2.6} />
      <path d="M14.9 12.3c3.4-.3 5.5 2.1 5.2 5.5-2.9 1.8-5.9 1.2-7.2-1.9" fill="none" strokeWidth={2.6} />
      <path d="M9.1 12.3c-3.4-.3-5.5 2.1-5.2 5.5 2.9 1.8 5.9 1.2 7.2-1.9" fill="none" strokeWidth={2.6} />
      <path d="M8 6.9A7.6 7.6 0 0 1 12 5.8a7.6 7.6 0 0 1 4 1.1M6 15.7a7.6 7.6 0 0 1-1.1-4M18 15.7a7.6 7.6 0 0 0 1.1-4" fill="none" />
    </IconFrame>
  );
}

export function PanIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M7.5 13.1V7.4a1.7 1.7 0 0 1 3.4 0v4.5-7a1.7 1.7 0 0 1 3.4 0v7-5.7a1.7 1.7 0 0 1 3.4 0v7.1-3.8a1.7 1.7 0 0 1 3.2 0v5.9c0 4.2-2.6 6.7-7 6.7h-1.6c-2.7 0-4.8-1.1-6.4-3.3l-2.7-3.7a1.8 1.8 0 0 1 2.7-2.4z" fill="none" />
      <path d="M10.9 12.2V7.4M14.3 12.2V5M17.7 13.4V6.7M7.5 15.2l-1.6-1.5" fill="none" />
    </IconFrame>
  );
}

export function BrushIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m15.8 2.9 5.3 5.3-7.5 7.5-5.3-5.3z" />
      <path d="M7.2 11.6 12.4 17M14.1 4.7l5.2 5.2M5 21.1c3.2-.5 5.2-2 6.1-4.5l-3.7-3.7c-.5 2.9-1.9 4.8-4.2 5.8 1 .2 1.6.9 1.8 2.4z" fill="none" />
      <path d="M4.8 18.5c1.6.4 3.2 0 4.7-1.1" fill="none" />
    </IconFrame>
  );
}

export function PauseIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M8 5v14M16 5v14" fill="none" /></IconFrame>;
}

export function PlayIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M8 5v14l11-7z" /></IconFrame>;
}

export function ResetIcon(props: IconProps) {
  return <IconFrame {...props}><path d="M5.1 7.5v5h5M5.8 12a6.5 6.5 0 1 0 2.1-4.8" fill="none" /></IconFrame>;
}
