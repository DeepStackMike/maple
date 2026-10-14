// Play/pause glyphs for the motion control, copied from the hosted app's icon
// set (`apps/web/src/components/icons/media-*`); `@maple/ui` doesn't ship them.
import type { IconProps } from "@maple/ui/components/icons/icon"

export function MediaPauseIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="currentColor"
			aria-hidden="true"
			{...props}
		>
			<path d="M5 4H9V20H5V4Z" />
			<path d="M15 4H19V20H15V4Z" />
		</svg>
	)
}

export function MediaPlayIcon({ size = 24, className, ...props }: IconProps) {
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			className={className}
			fill="currentColor"
			aria-hidden="true"
			{...props}
		>
			<path d="M6 4L6 20L20 12L6 4Z" />
		</svg>
	)
}
