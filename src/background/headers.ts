/** Request headers of the page's own media request that servers commonly check and `fetch` cannot set itself. */
const REPLAYED = ['referer', 'origin'];

export const pickReplayHeaders = (headers: chrome.webRequest.HttpHeader[] | undefined): Record<string, string> => {
	const picked: Record<string, string> = {};
	for (const header of headers ?? []) {
		const name = header.name.toLowerCase();
		if (REPLAYED.includes(name) && header.value) {
			picked[name] = header.value;
		}
	}
	return picked;
};

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const newRuleId = () => 1 + Math.floor(Math.random() * 2_000_000_000);

/**
 * Installs (or replaces) a session rule that sets `headers` on requests to `hosts`. The rule only matches requests
 * that do not belong to any tab, i.e. the extension's own fetches, so pages the user browses are never affected.
 */
export const setHeaderRule = async (ruleId: number, headers: Record<string, string>, hosts: string[]) => {
	const names = Object.keys(headers);
	if (names.length === 0 || hosts.length === 0) {
		await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
		return;
	}

	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [ruleId],
		addRules: [{
			id: ruleId,
			priority: 1,
			action: {
				type: 'modifyHeaders',
				requestHeaders: names.map(name => ({ header: name, operation: 'set', value: headers[name]! })),
			},
			condition: {
				regexFilter: `^https?://(${hosts.map(escapeRegex).join('|')})/`,
				tabIds: [chrome.tabs.TAB_ID_NONE],
				resourceTypes: ['xmlhttprequest', 'media', 'other'],
			},
		}],
	});
};

export const removeHeaderRule = (ruleId: number) => (
	chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] })
);

export const removeAllHeaderRules = async () => {
	const rules = await chrome.declarativeNetRequest.getSessionRules();
	await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id) });
};

/** Fetches a URL from the service worker with the given headers replayed for the duration of the request. */
export const fetchWithHeaders = async (url: string, headers: Record<string, string>): Promise<Response> => {
	const ruleId = newRuleId();
	await setHeaderRule(ruleId, headers, [new URL(url).host]);
	try {
		return await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(15_000) });
	} finally {
		await removeHeaderRule(ruleId);
	}
};
