declare module 'mpd-parser' {
	export function parse(xml: string, options?: { manifestUri?: string }): {
		duration?: number;
		playlists?: unknown[];
		mediaGroups?: { AUDIO?: Record<string, unknown> };
	};
}
