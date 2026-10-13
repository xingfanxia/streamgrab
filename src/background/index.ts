import { isEngineEvent, type UiCommand } from '../shared/messages';
import { forgetTab, onRequestFinished, onResponseStarted, onSendHeaders, scanPage, updateBadge } from './detect';
import { removeAllHeaderRules } from './headers';
import { clearFinished, dismissJob, revealJob, onBrowserDownloadChanged, onEngineEvent, reconcileJobs, startDownload, stopDownload } from './jobs';
import { previewTab } from './previews';
import { mutate } from './state';
import { probePage } from './ytdlp';

// Listeners are registered synchronously at the top level so that events wake the service worker.
const filter: chrome.webRequest.RequestFilter = {
	urls: ['http://*/*', 'https://*/*'],
	types: ['xmlhttprequest', 'media', 'main_frame', 'sub_frame', 'other'],
};
chrome.webRequest.onSendHeaders.addListener(onSendHeaders, filter, ['requestHeaders', 'extraHeaders']);
chrome.webRequest.onResponseStarted.addListener(details => void onResponseStarted(details), filter, ['responseHeaders']);
chrome.webRequest.onCompleted.addListener(onRequestFinished, filter);
chrome.webRequest.onErrorOccurred.addListener(onRequestFinished, filter);

chrome.webNavigation.onBeforeNavigate.addListener(details => {
	if (details.frameId === 0) {
		void forgetTab(details.tabId);
	}
});
chrome.tabs.onRemoved.addListener(tabId => void forgetTab(tabId));
chrome.downloads.onChanged.addListener(delta => void onBrowserDownloadChanged(delta));

chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
	if (isEngineEvent(message)) {
		// The engine waits for the reply to `host` before fetching, so the header rule is in place first.
		void onEngineEvent(message).finally(() => respond(true));
		return true;
	}

	const command = message as UiCommand;
	if (command?.type === 'download') {
		void startDownload(command);
	} else if (command?.type === 'stop') {
		void stopDownload(command.jobId, command.keep);
	} else if (command?.type === 'dismiss') {
		void dismissJob(command.jobId);
	} else if (command?.type === 'reveal') {
		void revealJob(command.jobId);
	} else if (command?.type === 'clearFinished') {
		void clearFinished();
	} else if (command?.type === 'probe') {
		void probePage(command.tabId);
	} else if (command?.type === 'scan') {
		void scanPage(command.tabId);
	} else if (command?.type === 'preview') {
		void previewTab(command.tabId);
	} else if (command?.type === 'forget') {
		void mutate(state => {
			delete state.media[command.tabId]?.[command.key];
		}).then(() => updateBadge(command.tabId));
	}
	return false;
});

const onStartup = async () => {
	await removeAllHeaderRules();
	await reconcileJobs();
};
chrome.runtime.onStartup.addListener(() => void onStartup());
chrome.runtime.onInstalled.addListener(() => void onStartup());
