import { createHmac, timingSafeEqual } from 'node:crypto';

export const EVENT_NOTIFICATION_SIGNATURE_HEADER = 'x-bz-event-notification-signature';

export function calculateSignature(message, signingSecret) {
	return createHmac('sha256', signingSecret)
		.update(message)
		.digest('hex');
}

export function buildControlSignaturePayload(method, url, body) {
	return [
		method.toUpperCase(),
		url.pathname,
		url.search,
		body
	].join('\n');
}

function signaturesMatch(receivedSig, calculatedSig) {
	if (receivedSig.length !== calculatedSig.length) {
		return false;
	}

	const encoder = new TextEncoder();
	return timingSafeEqual(
		encoder.encode(receivedSig),
		encoder.encode(calculatedSig)
	);
}

export function verifySignature(headers, signedContent, signingSecret) {
	if (!headers.has(EVENT_NOTIFICATION_SIGNATURE_HEADER)) {
		console.log('Missing signature header');
		return false;
	}

	// Verify that signature has form "v1=2c8...231"
	const signature = headers.get(EVENT_NOTIFICATION_SIGNATURE_HEADER);
	const pair = signature.split('=');
	if (!pair || pair.length !== 2 || !pair[1]) {
		console.log('Invalid signature format');
		return false;
	}
	const version = pair[0];
	if (version !== 'v1') {
		console.log(`Invalid signature version: ${version}`);
		return false;
	}

	const receivedSig = pair[1];
	const calculatedSig = calculateSignature(signedContent, signingSecret);
	if (!signaturesMatch(receivedSig, calculatedSig)) {
		console.log('Invalid signature');
		return false;
	}

	console.log('Signature is valid');
	return true;
}

function checkUUID(id) {
	const uuidRegExp = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;

	if (!uuidRegExp.test(id)) {
		throw new Error(`Bad UUID: ${id}`);
	}
}

function checkProperty(obj, objType, property, id) {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
		throw new Error(`Bad ${objType} object for ${id}`);
	}
	if (!Object.hasOwn(obj, property)) {
		throw new Error(`Missing ${property} property in ${objType} object for ${id}`);
	}
}

function parseIPv4(hostname) {
	const parts = hostname.split('.');
	if (parts.length !== 4) {
		return null;
	}

	const octets = parts.map((part) => {
		if (!/^\d+$/.test(part)) {
			return null;
		}
		const value = Number(part);
		return value >= 0 && value <= 255 ? value : null;
	});

	return octets.includes(null) ? null : octets;
}

function isRestrictedIPv4(hostname) {
	const octets = parseIPv4(hostname);
	if (!octets) {
		return false;
	}

	const [first, second] = octets;
	return first === 0
		|| first === 10
		|| first === 127
		|| (first === 169 && second === 254)
		|| (first === 172 && second >= 16 && second <= 31)
		|| (first === 192 && second === 168);
}

function isRestrictedIPv6(hostname) {
	const host = hostname.replace(/^\[(.*)]$/, '$1').toLowerCase();
	if (!host.includes(':')) {
		return false;
	}

	if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
		return true;
	}

	if (host.startsWith('::ffff:')) {
		return isRestrictedIPv4(host.slice('::ffff:'.length));
	}

	const firstHextet = host.split(':').find((part) => part.length > 0);
	if (!firstHextet || !/^[0-9a-f]+$/.test(firstHextet)) {
		return false;
	}

	const firstValue = parseInt(firstHextet, 16);
	return (firstValue & 0xfe00) === 0xfc00
		|| (firstValue & 0xffc0) === 0xfe80;
}

function isRestrictedHostname(hostname) {
	const host = hostname.toLowerCase();
	return host === 'localhost'
		|| host.endsWith('.localhost')
		|| host.endsWith('.local')
		|| isRestrictedIPv4(host)
		|| isRestrictedIPv6(host);
}

export function normalizeSubscription(subscription, id = 'payload') {
	checkProperty(subscription, 'subscription', 'url', id);

	let url;
	try {
		url = new URL(subscription.url);
	} catch {
		throw new Error(`Bad url in subscription object for ${id}`);
	}

	if (url.protocol !== 'https:') {
		throw new Error(`Subscription url must use https for ${id}`);
	}

	if (isRestrictedHostname(url.hostname)) {
		throw new Error(`Subscription url host is not allowed for ${id}`);
	}

	return {
		url: url.toString()
	};
}

export function normalizeSubscriptions(subscriptions) {
	if (!subscriptions || typeof subscriptions !== 'object' || Array.isArray(subscriptions)) {
		throw new Error('Subscriptions payload must be an object');
	}

	const normalizedSubscriptions = {};
	for (const [id, subscription] of Object.entries(subscriptions)) {
		checkUUID(id);
		normalizedSubscriptions[id] = normalizeSubscription(subscription, id);
	}

	return normalizedSubscriptions;
}
