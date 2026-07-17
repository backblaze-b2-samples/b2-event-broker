import assert from 'node:assert/strict';
import test from 'node:test';

import {
	EVENT_NOTIFICATION_SIGNATURE_HEADER,
	buildControlSignaturePayload,
	calculateSignature,
	normalizeSubscription,
	normalizeSubscriptions,
	verifySignature
} from '../src/security.js';

const SECRET = 'test-signing-secret';
const SUBSCRIPTION_ID = '2bdd4246-d838-4c0a-9a50-a7483534836e';

function headersFor(message) {
	return new Headers({
		[EVENT_NOTIFICATION_SIGNATURE_HEADER]: `v1=${calculateSignature(message, SECRET)}`
	});
}

function withoutConsoleLog(callback) {
	const originalLog = console.log;
	const logs = [];
	console.log = (...args) => logs.push(args.join(' '));

	try {
		return {
			result: callback(),
			logs
		};
	} finally {
		console.log = originalLog;
	}
}

test('invalid signatures do not log reusable signing material', () => {
	const body = '{"url":"https://attacker.example/sink"}';
	const calculatedSignature = calculateSignature(body, SECRET);
	const headers = new Headers({
		[EVENT_NOTIFICATION_SIGNATURE_HEADER]: 'v1=0'
	});

	const { result, logs } = withoutConsoleLog(() => verifySignature(headers, body, SECRET));
	const logText = logs.join('\n');

	assert.equal(result, false);
	assert.ok(!logText.includes('v1=0'));
	assert.ok(!logText.includes(calculatedSignature));
	assert.ok(!logText.includes(body));
	assert.ok(!logText.includes('attacker.example'));
});

test('control signatures are scoped to method, path, query, and body', () => {
	const signedGet = buildControlSignaturePayload(
		'GET',
		new URL('https://event-broker.example/@subscriptions/source-bucket/allEvents'),
		''
	);
	const getHeaders = headersFor(signedGet);

	const deniedControlReads = [
		buildControlSignaturePayload(
			'HEAD',
			new URL('https://event-broker.example/@subscriptions/source-bucket/allEvents'),
			''
		),
		buildControlSignaturePayload(
			'GET',
			new URL('https://event-broker.example/@subscriptions'),
			''
		),
		buildControlSignaturePayload(
			'GET',
			new URL('https://event-broker.example/@subscriptions/source-bucket/allEvents?cursor=next'),
			''
		),
		buildControlSignaturePayload(
			'GET',
			new URL('https://event-broker.example/@subscriptions/victim-bucket/allEvents'),
			''
		)
	];

	const { result: validGet } = withoutConsoleLog(() => verifySignature(getHeaders, signedGet, SECRET));
	assert.equal(validGet, true);
	for (const signedContent of deniedControlReads) {
		const { result } = withoutConsoleLog(() => verifySignature(getHeaders, signedContent, SECRET));
		assert.equal(result, false);
	}

	const postBody = '{"url":"https://subscriber.example/callback"}';
	const signedPost = buildControlSignaturePayload(
		'POST',
		new URL('https://event-broker.example/@subscriptions/source-bucket/allEvents'),
		postBody
	);
	const postHeaders = headersFor(signedPost);
	const crossBucketPost = buildControlSignaturePayload(
		'POST',
		new URL('https://event-broker.example/@subscriptions/victim-bucket/allEvents'),
		postBody
	);
	const { result: postResult } = withoutConsoleLog(() => verifySignature(postHeaders, crossBucketPost, SECRET));
	assert.equal(postResult, false);
	const changedPostBody = buildControlSignaturePayload(
		'POST',
		new URL('https://event-broker.example/@subscriptions/source-bucket/allEvents'),
		'{"url":"https://other.example/callback"}'
	);
	const { result: changedPostResult } = withoutConsoleLog(() => verifySignature(postHeaders, changedPostBody, SECRET));
	assert.equal(changedPostResult, false);

	const signedDelete = buildControlSignaturePayload(
		'DELETE',
		new URL(`https://event-broker.example/@subscriptions/source-bucket/allEvents/${SUBSCRIPTION_ID}`),
		''
	);
	const deleteHeaders = headersFor(signedDelete);
	const crossBucketDelete = buildControlSignaturePayload(
		'DELETE',
		new URL(`https://event-broker.example/@subscriptions/victim-bucket/allEvents/${SUBSCRIPTION_ID}`),
		''
	);
	const { result: deleteResult } = withoutConsoleLog(() => verifySignature(deleteHeaders, crossBucketDelete, SECRET));
	assert.equal(deleteResult, false);
});

test('subscription URLs must be https and externally routable', () => {
	const invalidUrls = [
		'http://subscriber.example/callback',
		'https://127.0.0.1/callback',
		'https://localhost/callback',
		'https://169.254.169.254/latest/meta-data/',
		'https://10.0.0.2/callback',
		'https://172.16.1.2/callback',
		'https://192.168.1.2/callback',
		'https://[::1]/callback',
		'https://[fc00::1]/callback'
	];

	for (const url of invalidUrls) {
		assert.throws(
			() => normalizeSubscription({ url }),
			/Subscription url/
		);
	}

	assert.deepEqual(
		normalizeSubscription({ url: 'https://subscriber.example/callback' }),
		{ url: 'https://subscriber.example/callback' }
	);
});

test('subscription replacement payloads are validated and normalized', () => {
	assert.throws(() => normalizeSubscriptions([]), /must be an object/);
	assert.throws(() => normalizeSubscriptions(null), /must be an object/);
	assert.throws(
		() => normalizeSubscriptions(JSON.parse('{"__proto__":{"url":"https://subscriber.example/callback"}}')),
		/Bad UUID/
	);
	assert.throws(
		() => normalizeSubscriptions({ [SUBSCRIPTION_ID]: {} }),
		/Missing url/
	);
	assert.throws(
		() => normalizeSubscriptions({ [SUBSCRIPTION_ID]: { url: 'http://subscriber.example/callback' } }),
		/must use https/
	);

	assert.deepEqual(
		normalizeSubscriptions({
			[SUBSCRIPTION_ID]: {
				url: 'https://subscriber.example/callback',
				extra: 'ignored'
			}
		}),
		{
			[SUBSCRIPTION_ID]: {
				url: 'https://subscriber.example/callback'
			}
		}
	);
});
