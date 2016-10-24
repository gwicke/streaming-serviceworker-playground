'use strict';

const tplURL = 'https://crossorigin.me/https://en.m.wikipedia.org/wiki/Test';
const swt = require('sw-toolbox');
const HTMLTransformReader = require('web-html-stream').HTMLTransformReader;
const streamUtil = require('web-stream-util');

const testHosts = /^https?:\/\/(?:localhost:8934|swproxy(?:-mobile)?.wmflabs.org)\//;
function rewriteRequestHost(request) {
    if (testHosts.test(request.url)) {
        // Performance hack: rewrite to enwiki.
        const url = request.url.replace(testHosts, 'https://en.wikipedia.org/');
        request = new Request(url, request);
    }
    return request;
}

// Basic ServiceWorker toolbox setup.
swt.precache([tplURL]);
// swt.options.debug = true;
swt.router.default = (request, options) => {
    return swt.networkFirst(rewriteRequestHost(request), options);
};
swt.options.cache.name = 'default';
swt.options.cache.maxEntries = 5000;

// HTMLTransformReader configuration that matches the body element & returns
// innerHTML as a stream.
const bodyExtractTransform = {
    transforms: [{
        selector: 'body',
        // Simply pass through the stream for now. Later, we can add
        // transforms on the body stream as well.
        handler(node) { return node.innerHTML; },
        // Handler wants innerHTML / outerHTML as streams / Reader instances.
        stream: true,
    }],
    // Only return matches & drop un-matched content.
    matchOnly: true
};

function fetchBody(req, title) {
    // const protoHost = req.url.match(/^(https?:\/\/[^\/]+)\//)[1];
    const normalizedTitle = encodeURIComponent(decodeURIComponent(title));
    const url = `https://en.wikipedia.org/api/rest_v1/page/html/${normalizedTitle}`;
    return swt.networkFirst(new Request(url), {
        cache: {
            name: 'api_html',
            maxEntries: 100,
            maxAgeSeconds: 186400
        }
    })
    .then((res) => {
        if (res.status === 200) {
            // Extract body. This reader returns a ReadableStream for the body in its first value.
            const reader = new streamUtil.TextDecodeReader(res.body);
            return new HTMLTransformReader(reader, bodyExtractTransform);
        } else {
            return `<body><em style="color: red">Error fetching body for ${title}:
                ${res.status}<em></body>`;
        }
    },
    err => `<body><em style="color: red">Error fetching body for ${title}:
            ${err}</em></body>`);
}

function getTemplate() {
    return swt.cacheFirst(new Request(tplURL))
        .then((res) => {
            if (res.status !== 200) {
                throw res;
            }
            return res.text();
        })
        .then(tpl => tpl
            .replace('<base[^>]+href=[^>]+>', '')
            .replace(/modules=([^&]+)&/,
                'modules=$1%7Cmediawiki.skinning.content.parsoid%7Cext.cite.style&'));
}

// HACK: Replace "Test" (template title) with the current page title in
// template source.
class HackyReplaceReader {
    constructor(input, ctx) {
        this._reader = streamUtil.toReader(input);
        this._ctx = ctx;
    }

    read() {
        return this._reader.read()
        .then((res) => {
            if (res.done) {
                return res;
            }
            if (typeof res.value === 'string') {
                // Don't care about chunk boundaries for this hack.. but if we
                // did, we'd just hold onto the last three bytes.
                res.value = res.value.replace(/Test/g, this._ctx.htmlTitle);
            }
            return res;
        });
    }

    cancel(reason) {
        this._reader.cancel(reason);
    }
}

// Template handlers.
const pageTemplateTransforms = {
    transforms: [
        // Very incomplete.
        {
            selector: 'h1[id="section_0"]',
            handler(node) {
                return (ctx) => {
                    return `<h1 id="section_0">${ctx.htmlTitle}</h1>`;
                };
            }
        }, {
            selector: 'div[id="mw-content-text"]',
            handler(node) {
                return (ctx) => {
                    // Use the evaluation context
                    return fetchBody(ctx.req, ctx.title);
                };
            }
        }
    ]
};

let compiledTemplate;
function getCompiledTemplate() {
    if (compiledTemplate) {
        return Promise.resolve(compiledTemplate);
    } else {
        return getTemplate()
            .then((tpl) => {
                compiledTemplate = new HTMLTransformReader(tpl, pageTemplateTransforms).drainSync();
                return compiledTemplate;
            });
    }
}

const escapes = {
    '<': '&lt;',
    '"': '&quot;',
    "'": '&#39;'
};

function assemblePage(req, tpl) {
    const title = req.url.match(/\/wiki\/([^?]+)$/)[1];
    const ctx = {
        req,
        title,
        htmlTitle: title.split('/').map(decodeURIComponent).join('/')
                         .replace(/[<"']/g, s => escapes[s])
                         .replace(/_/g, ' ')
    };

    // Hacky replaces on the template.
    // TODO: Move all dynamic bits in the skin to pre-compiled templates /
    // widgets.
    let reader = new HackyReplaceReader(tpl, ctx);
    // Flatten / evaluate stream.
    reader = new streamUtil.FlatStreamReader(reader, ctx);
    // Convert to bytes.
    reader = new streamUtil.TextEncodeReader(reader);
    // Finally, wrap into a ReadableStream for browser /
    // node-serviceworker-proxy consumption.
    return streamUtil.toStream(reader);
}

// Wiki page entry point
swt.router.get(/https?:\/\/(?!login\.)[^\/]+\/wiki\/.+$/, (request, options) => {
    return getCompiledTemplate()
        .then((tpl) => {
            const body = assemblePage(request, tpl);
            return new Response(body, {
                headers: {
                    'content-type': 'text/html;charset=utf8'
                }
            });
        });
});

// Use cacheFirst for RL requests
swt.router.get("/w/load.php", (request, options) => {
    return swt.cacheFirst(rewriteRequestHost(request), options);
});

// Boilerplate to ensure our service worker takes control of the page as soon
// as possible.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
