import SvgIcon, { type SvgIconProps } from '@mui/material/SvgIcon'

/** Rounded custom icon for printer/device surfaces across the web app. */
export function Printer3dRoundedIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path d="M6.2 4.1h11.6c.65 0 1.2.55 1.2 1.2v13.4c0 .65-.55 1.2-1.2 1.2H6.2c-.65 0-1.2-.55-1.2-1.2V5.3c0-.65.55-1.2 1.2-1.2Z" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round" />
      <path d="M7.5 8.05h9" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" />
      <rect x="10.3" y="7.25" width="3.4" height="3.2" rx="0.7" fill="currentColor" />
      <path d="M11.1 10.25h1.8L12 12l-.9-1.75Z" fill="currentColor" />
      <path d="M8.25 17.55h7.5" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
      <rect x="10" y="13.75" width="4" height="3" rx="0.55" fill="currentColor" />
    </SvgIcon>
  )
}