import { DurableObject } from 'cloudflare:workers';
import { v4 as uuidv4 } from 'uuid';

import { createHmac } from 'node:crypto';

const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_UNAUTHORIZED = 401;
const HTTP_STATUS_NOT_FOUND = 404;
const HTTP_STATUS_METHOD_NOT_ALLOWED = 405;
const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;

const EVENT_NOTIFICATION_SIGNATURE_HEADER = 'x-bz-event-notification-signature';

const DEFAULT_MAX_FAILURE_COUNT = 5;

class NotFoundError extends Error {
	constructor(message) {
		super(`NotFoundError: ${message}`);
	}
}

class MethodNotAllowedError extends Error {
	constructor(message) {
		super(`MethodNotAllowedError: ${message}`);
	}
}

function verifySignature(headers, body, signingSecret) {
	if (headers.has(EVENT_NOTIFICATION_SIGNATURE_HEADER)) {
		// Verify that signature has form "v1=2c8...231"
		const signature = headers.get(EVENT_NOTIFICATION_SIGNATURE_HEADER);
		const pair = signature.split('=');
		if (!pair || pair.length !== 2) {
			console.log(`Invalid signature format: ${signature}`);
			return false;
		}
		const version = pair[0];
		if (version !== 'v1') {
			console.log(`Invalid signature version: ${version}`);
			return false;
		}

		// Now calculate the HMAC and compare it with the one sent in the header
		const receivedSig = pair[1];
		const calculatedSig = createHmac('sha256', signingSecret)
			.update(body)
			.digest('hex');
		if (receivedSig !== calculatedSig) {
			console.log(`Invalid signature. Received ${receivedSig}; calculated ${calculatedSig}`);
			return false;
		}
	} else {
		console.log('Missing signature header');
		return false;
	}

	// Success!
	console.log('Signature is valid');
	return true;
}

function checkUUID(id) {
	const uuidRegExp = /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/i;

	if (!uuidRegExp.test(id)){
		throw new Error(`Bad UUID: ${id}`);
	}
}

function checkProperty(obj, objType, property, id) {
	if (!Object.hasOwn(obj, property)) {
		throw new Error(`Missing ${property} property in ${objType} object for ${id}`);
	}
}

/** A Durable Object's behavior is defined in an exported Javascript class */
export class EventSubscriptions extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
	}

	async createSubscription(bucketName, ruleName, subscription) {
		if (!subscription.url) {
			throw new Error('No url in payload.');
		}
		if (!URL.canParse(subscription.url)) {
			throw new Error('url in payload is not valid.');
		}
		const rules = (await this.ctx.storage.get(bucketName)) || {};
		const subscriptions = rules[ruleName] || {};
		const id = uuidv4();
		subscriptions[id] = {
			url: subscription.url
		};
		rules[ruleName] = subscriptions;
		await this.ctx.storage.put(bucketName, rules);
		console.log('Created subscription:', bucketName, ruleName, id);
		return { "id": id };
	}

	// One method to walk the parameters from the path, returning the appropriate data
	async getSubscriptions(bucketName, ruleName, id) {
		// GET /@subscriptions
		if (!bucketName) {
			console.log(`Returning rules for all buckets`);
			// Convert Map to object so that it is JSON-serializable
			return Object.fromEntries((await this.ctx.storage.list()) || []);
		}

		// GET /@subscriptions/mybucket
		const rules = await this.ctx.storage.get(bucketName);
		if (!rules) {
			throw new NotFoundError(`No rules found for ${bucketName}`);
		}
		if (!ruleName) {
			console.log(`Returning rules for ${bucketName}`);
			return rules;
		}

		// GET /@subscriptions/mybucket/myRuleName
		if (!Object.hasOwn(rules, ruleName)) {
			throw new NotFoundError(`Rule ${ruleName} not found for ${bucketName}`);
		}
		const subscriptions = rules[ruleName];
		if (!id) {
			console.log(`Returning subscriptions for ${bucketName}/${ruleName}`);
			return subscriptions;
		}

		// GET /@subscriptions/mybucket/myRuleName/2bdd4246-d838-4c0a-9a50-a7483534836e
		if (!Object.hasOwn(subscriptions, id)) {
			throw new NotFoundError(`ID ${id} not found for ${bucketName}/${ruleName}`);
		}
		console.log(`Returning subscription for ${bucketName}/${ruleName}/${id}`);
		return subscriptions[id];
	}

	async setSubscriptions(bucketName, ruleName, subscriptions) {
		for (const [id, subscription] of Object.entries(subscriptions)) {
			checkUUID(id);
			checkProperty(subscription, 'subscription', 'url', id);
		}
		const rules = await this.ctx.storage.get(bucketName);
		rules[ruleName] = subscriptions;
		await this.ctx.storage.put(bucketName, rules);
		console.log(`Updated subscriptions for ${bucketName}/${ruleName}`)
	}

	async deleteSubscription(bucketName, ruleName, id) {
		const rules = await this.ctx.storage.get(bucketName);
		if (!rules) {
			throw new NotFoundError(`No subscriptions for ${ruleName}`);
		}
		if (Object.hasOwn(rules, ruleName)) {
			const subscriptions = rules[ruleName];
			if (Object.hasOwn(subscriptions, id)) {
				let deleted = subscriptions[id];
				delete subscriptions[id];
				console.log(`Deleted subscription ${bucketName}/${ruleName}/${id}`);
				if (Object.keys(subscriptions).length === 0) {
					console.log(`No more subscriptions in ${bucketName}/${ruleName}`);
					delete rules[ruleName];
				}
				if (Object.keys(rules).length > 0) {
					console.log(`Updating rules for ${bucketName}/${ruleName}`);
					await this.ctx.storage.put(bucketName, rules);
				} else {
					console.log(`No more rules in ${bucketName}`);
					await this.ctx.storage.delete(bucketName);
				}
				return deleted;
			} else {
				throw new NotFoundError(`ID ${id} not found for ${bucketName}/${ruleName}`);
			}
		} else {
			throw new NotFoundError(`Rule ${ruleName} not found for ${bucketName}`);
		}
	}
}

async function handleSubscriptionRequest(url, method, payload, stub) {
	// pathname is of the form '/@subscriptions/mybucket/myRuleName/2bdd4246-d838-4c0a-9a50-a7483534836e'
	// split returns an empty first element, since the pathname starts with the separator
	const [_empty, resource, bucketName, ruleName, id] = url.pathname.split('/');

	console.log(`Handling ${method} request for ${resource}/${bucketName}/${ruleName}/${id}`);

	if (resource !== '@subscriptions') {
		throw new NotFoundError(`Bad resource ${resource}`);
	}

	if (method === 'GET' || method === 'HEAD') {
		// Can GET/HEAD any sub path - getSubscriptions figures it out
		const result = await stub.getSubscriptions(bucketName, ruleName, id);
		return (method === 'GET') ? result : null;
	}

	// POST and DELETE both require bucketName and ruleName, so if we're here without one of them, throw method error -
	// you could GET that URL, but you can't POST/DELETE it.
	if (!bucketName || !ruleName) {
		throw new MethodNotAllowedError(`${method} not allowed for ${url}`);
	}

	let response;
	switch (method) {
		case 'POST':
			if (!payload) {
				throw new Error('Missing payload in POST request');
			}
			// Create a new subscription
			response = await stub.createSubscription(bucketName, ruleName, payload);
			break;
		case 'DELETE':
			if (!id) {
				// Again, you could GET this URL, but you can't DELETE it
				throw new MethodNotAllowedError(`${method} not allowed for ${url}`);
			}
			// Delete the subscription
			response = await stub.deleteSubscription(bucketName, ruleName, id);
			break;
		default:
			throw new MethodNotAllowedError(`${method} not allowed for ${url}`);
	}

	return response;
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(resource, options, maxFailureCount) {
	// Delay will be 0, 1, 2, 4, etc. (in seconds)
	let delay = 0;

	for (let i = 0; i < maxFailureCount; i++) {
		let response = null, reason = null;
		try {
			response = await fetch(resource, options);
		} catch (e) {
			reason = e;
		}

		if (response?.ok) {
			console.log(`POST to ${resource} succeeded with status ${response.status}`);
			return response;
		} else {
			if (response) {
				console.log(`POST to ${resource} failed with status ${response.status}, body ${await response.text()}`);
			} else {
				console.log(`POST to ${resource} failed: ${reason}`);
			}

			await sleep(delay);
			delay = (delay === 0) ? 1000 : delay * 2;
		}
	}

	throw new Error(`${maxFailureCount} failures to ${options.method} ${resource}`);
}

async function handleEventNotifications(events, env, stub) {
	const maxFailureCount = Object.hasOwn(env, 'MAX_FAILURE_COUNT')
		? parseInt(env.MAX_FAILURE_COUNT, 10)
		: DEFAULT_MAX_FAILURE_COUNT;

	try {
		console.log(`Handling batch of ${events.length} notifications`)

		// TBD batch notifications back together
		for (let event of events) {
			let subscriptions = null;
			try {
				subscriptions = await stub.getSubscriptions(event.bucketName, event.matchedRuleName);
			} catch (e) {
				if (e instanceof NotFoundError || (e.remote && e.message.startsWith('NotFoundError'))) {
					subscriptions = [];
				} else {
					console.log(`Error getting subscriptions: {e}`);
					return;
				}
			}

			if (Object.entries(subscriptions).length === 0) {
				console.log(`No subscribers to ${event.bucketName}/${event.matchedRuleName}`)
			}

			const promises = [], sent = [];
			for (const [id, subscription] of Object.entries(subscriptions)) {
				console.log(`POSTing to ${subscription.url}`);
				promises.push(fetchWithRetry(subscription.url, {
					method: 'POST',
					body: JSON.stringify({ "event": [event] })
				}, maxFailureCount));
				sent.push({ 'id': id, 'subscription': subscription });
			}

			const outcomes = await Promise.allSettled(promises);
			for (let i = 0; i < outcomes.length; i++) {
				const outcome = outcomes[i];
				const { id, subscription } = sent[i];

				if (outcome.status === 'rejected') {
					console.log(outcome.reason);
					console.log(`Removing subscription ${id} of ${subscription.url} to ${event.matchedRuleName}`);
					await stub.deleteSubscription(event.bucketName, event.matchedRuleName, id)
				}
			}
		}
	} catch (e) {
		console.error(e.stack);
	}
}

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param {Request} request - The request submitted to the Worker from the client
	 * @param {Env} env - The interface to reference bindings declared in wrangler.toml
	 * @param {ExecutionContext} ctx - The execution context of the Worker
	 * @returns {Promise<Response>} The response to be sent back to the client
	 */
	async fetch(request, env, ctx) {
		if (!Object.hasOwn(env, 'SIGNING_SECRET')) {
			console.log('You must set SIGNING_SECRET as a Cloudflare Secret');
			return new Response(null, {status: HTTP_STATUS_INTERNAL_SERVER_ERROR});
		}

		const bodyText = await request.text();

		if (!verifySignature(request.headers, bodyText, env.SIGNING_SECRET)){
			return new Response(null, {status: HTTP_STATUS_UNAUTHORIZED});
		}

		let payload = null
		if (request.method === 'POST' && bodyText.length > 0) {
			try {
				payload = JSON.parse(bodyText);
			} catch (e) {
				console.error(e.stack)
				return new Response(null, {status: HTTP_STATUS_BAD_REQUEST});
			}
		}

		// Use the Worker host as the durable object name
		const url = new URL(request.url);
		const object_id = env.EVENT_SUBSCRIPTIONS.idFromName(url.host);
		const stub = env.EVENT_SUBSCRIPTIONS.get(object_id);

		let response;
		if (url.pathname.startsWith('/@')) {
			// Control message
			try {
				let reply = await handleSubscriptionRequest(url, request.method, payload, stub);
				console.log('reply:', reply);
				response = reply ? Response.json(reply) : new Response(null, {status: HTTP_STATUS_OK});
			} catch (e) {
				let status = HTTP_STATUS_BAD_REQUEST;
				if (e instanceof NotFoundError || (e.remote && e.message.startsWith('NotFoundError'))) {
					status = HTTP_STATUS_NOT_FOUND;
				} else if (e instanceof MethodNotAllowedError || (e.remote && e.message.startsWith('MethodNotAllowedError'))) {
					status = HTTP_STATUS_NOT_FOUND;
				}
				response = new Response(e.message, { status: status });
			}
		} else {
			// Event notification
			if (request.method === 'POST') {
				// We don't need to block while we send notifications to subscribers, since we send a 200 response no matter what.
				// Use ctx.waitUntil to perform the notifications after the response is returned.
				ctx.waitUntil(handleEventNotifications(payload.events, env, stub));

				// Always respond 200 to B2 Event Notifications service
				response = new Response(null, {status: HTTP_STATUS_OK});
			} else {
				// Only POST is allowed
				response = new Response(null, {status: HTTP_STATUS_METHOD_NOT_ALLOWED});
			}
		}

		return response;
	},
};
