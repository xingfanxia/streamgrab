/**
 * Sites whose media sits behind signed or site-specific APIs. Their pages are handed to yt-dlp, and the media
 * chunks their players fetch are not listed, since each is only a fragment of a stream.
 */
export const PAGE_SITES = /(^|\.)(youtube\.com|youtu\.be|bilibili\.com|b23\.tv|twitch\.tv|tiktok\.com|douyin\.com|vimeo\.com|dailymotion\.com|nicovideo\.jp|soundcloud\.com|xiaohongshu\.com|xhslink\.com|weibo\.com|instagram\.com)$/;

export const isPageSite = (url: string | undefined): boolean => {
	try {
		return PAGE_SITES.test(new URL(url ?? '').hostname);
	} catch {
		return false;
	}
};
