const hostMatches = (pattern: RegExp) => (url: string | undefined): boolean => {
	try {
		return pattern.test(new URL(url ?? '').hostname);
	} catch {
		return false;
	}
};

/**
 * Sites whose players fetch media only as fragments of a stream with no standard manifest. Nothing useful can be
 * picked off the network there, so script-fetched media is not listed at all and the page is left to yt-dlp.
 */
export const isFragmentSite = hostMatches(/(^|\.)(youtube\.com|youtu\.be|bilibili\.com|b23\.tv|twitch\.tv|vimeo\.com|dailymotion\.com|nicovideo\.jp|soundcloud\.com)$/);

/**
 * Sites yt-dlp is asked about as soon as the popup opens. On the ones beyond the fragment sites, network detection
 * also works to a degree, and its results are shown only when yt-dlp has nothing.
 */
export const isPageSite = (url: string | undefined): boolean => (
	isFragmentSite(url) || hostMatches(/(^|\.)(xiaohongshu\.com|xhslink\.com|weibo\.com|instagram\.com|tiktok\.com)$/)(url)
);

/**
 * Rewrites a page address into the form yt-dlp recognises, for sites that show a video in an overlay on top of a
 * feed and keep the feed's address with the video's id in the query string.
 */
export const pageUrlForYtDlp = (url: string): string => {
	try {
		const parsed = new URL(url);
		const overlayId = parsed.searchParams.get('modal_id');
		if (/(^|\.)douyin\.com$/.test(parsed.hostname) && overlayId && /^\d+$/.test(overlayId)) {
			return `https://www.douyin.com/video/${overlayId}`;
		}
	} catch {
		// Not an address; yt-dlp will say so.
	}
	return url;
};
