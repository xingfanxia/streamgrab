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
export const isFragmentSite = hostMatches(/(^|\.)(youtube\.com|youtu\.be|bilibili\.com|b23\.tv|twitch\.tv|tiktok\.com|douyin\.com|vimeo\.com|dailymotion\.com|nicovideo\.jp|soundcloud\.com)$/);

/**
 * Sites yt-dlp is asked about as soon as the popup opens. On the ones beyond the fragment sites, network detection
 * also works to a degree, and its results are shown only when yt-dlp has nothing.
 */
export const isPageSite = (url: string | undefined): boolean => (
	isFragmentSite(url) || hostMatches(/(^|\.)(xiaohongshu\.com|xhslink\.com|weibo\.com|instagram\.com)$/)(url)
);
