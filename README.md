# Backblaze B2 Event Broker

The Backblaze B2 Event Broker is a [Cloudflare Worker](https://developers.cloudflare.com/workers/) that forwards Backblaze B2 Event Notifications to subscribers. The event broker implements a simple RESTful API for clients to create, query and delete subscriptions.

The event broker is intended for use with [B2listen](https://github.com/backblaze-b2-samples/b2listen/), but may be useful in other situations.

## Event Notifications

The event broker is designed to receive event notification messages from Backblaze B2 and forward them to subscribers. All incoming HTTP POST requests that do not include the subscriptions path prefix, `/@subscriptions`, are treated as event notifications.

The event broker validates that incoming event notifications are signed with the shared secret, then responds to Backblaze B2 with a 200 HTTP status code and empty payload before forwarding the event notification(s) to subscribers.

## Subscriptions

Subscriptions are resources with URL paths of the form `/@subscriptions/{bucket-name}/{rule-name}/{id}` and content of the form:

```json
{
	"url": "https://example.com/listener"
}
```

ALL incoming requests, both subscription requests and event notifications, must be signed using a shared secret. The shared secret is the same as the shared secret in your event notification rule(s), and is configured as a [Cloudflare Secret](https://developers.cloudflare.com/workers/configuration/secrets/) so that the event broker can validate the signature.

### Configuration

Before deploying the worker, you must [configure a Cloudflare Secret](https://developers.cloudflare.com/workers/configuration/secrets/#secrets-on-deployed-workers) named `SIGNING_SECRET` with the shared secret from your event notification rule(s).

The `wrangler.toml` file includes a variable, `MAX_FAILURE_COUNT`, that controls the number of delivery attempts that the event broker will make for an event notification before automatically removing a subscription. The first retry is immediate, the second after 1 second, the third after 2 seconds, the fourth after 4 seconds, and so on.

### Create a Subscription

POST a JSON-formatted body containing the subscriber URL to a URL of the form `/@subscriptions/{bucket-name}/{rule-name}`. The event broker will respond with a JSON-formatted message containing the subscription ID. For example:

```console
% curl https://event-broker.acme.workers.dev/@subscriptions/my-bucket/my-rule \
    -d '{ "url" : "https://example.com/listener" }' \
    -H 'x-bz-event-notification-signature: v1=355caf3f1a5e92ba2bea08394f0d68d3952c79d1055574f540faef1dcaea77b5'
{"id":"ce986d9c-86f3-4fb4-99d6-366acbb133c9"}
```

### Get Subscription Details

GET the subscription's URL to receive JSON-formatted subscription details:

```console
% curl https://event-broker.acme.workers.dev/@subscriptions/metadaddy-tester/allEvents/ce986d9c-86f3-4fb4-99d6-366acbb133c9 -H 'x-bz-event-notification-signature: v1=329b6adc5eb23b4221ada77fe19751e30a92ba17c5518cb0d44ed00b5dbdb08c'
{"url":"https://example.com/listener"}
```

### Delete a Subscription

Send a DELETE request to the subscription's URL. The event broker responds with the subscription details.

```console
% curl https://event-broker.acme.workers.dev/@subscriptions/metadaddy-tester/allEvents/ce986d9c-86f3-4fb4-99d6-366acbb133c9 -H 'x-bz-event-notification-signature: v1=329b6adc5eb23b4221ada77fe19751e30a92ba17c5518cb0d44ed00b5dbdb08c' -X DELETE
{"url":"https://example.com/listener"}
```
