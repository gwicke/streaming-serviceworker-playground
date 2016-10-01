'use strict';

const tplURL = '/w/index.php?title=Test';
const swt = require('sw-toolbox');
const HTMLTransformReader = require('web-html-stream').HTMLTransformReader;
const streamUtil = require('web-stream-util');

swt.precache([tplURL]);
// swt.options.debug = true;
const testHosts = /^https?:\/\/(?:localhost:8934|swproxy.wmflabs.org)\//;
function rewriteRequestHost(request) {
    if (testHosts.test(request.url)) {
        // Performance hack: rewrite to enwiki.
        const url = request.url.replace(testHosts, 'https://en.wikipedia.org/');
        request = new Request(url, request);
    }
    return request;
}


swt.router.default = function(request, options) {
    return swt.networkFirst(rewriteRequestHost(request), options);
};
swt.options.cache.name = 'default';
swt.options.cache.maxEntries = 5000;

let compiledTemplate;
const pageTemplateTransforms = {
    transforms: [
        {
            selector: 'h1[id="firstHeading"]',
            handler: (node) => function(ctx) {
                return `<h1 id="firstHeading">${ctx.htmlTitle}</h1>`;
            }
        }, {
            selector: 'div[id="mw-content-text"]',
            handler: (node) => function(ctx) {
                // Use the evaluation context
                return fetchBody(ctx.req, ctx.title);
            }
        }
    ]
};

const bodyExtractTransform = {
    transforms: [{
        selector: {
            nodeName: 'body',
        },
        // Simply pass through the stream for now.
        // Later, we can filter the body stream as well.
        handler: node => node.innerHTML,
        stream: true,
    }],
    matchOnly: true
};

function fetchBody(req, title) {
	//const protoHost = req.url.match(/^(https?:\/\/[^\/]+)\//)[1];
    return swt.cacheFirst(new Request('https://en.wikipedia.org/api/rest_v1/page/html/'
                + encodeURIComponent(decodeURIComponent(title))), {
                    cache: {
                        name: 'api_html',
                        maxEntries: 100,
                        maxAgeSeconds: 186400
                    }
    })
    .then(res => {
        if (res.status === 200) {
            // Extract body. This reader returns a ReadableStream for the body in its first value.
            let reader = new streamUtil.TextDecodeReader(res.body);
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
        .then(res => res.text())
        .then(tpl => tpl
            .replace('<base[^>]+href=[^>]+>', '')
            .replace(/modules=([^&]+)&/,
                'modules=$1%7Cmediawiki.skinning.content.parsoid%7Cext.cite.style&'));
}

const escapes = {
    '<': '&lt;',
    '"': '&quot;',
    "'": '&#39;'
};

class HackyReplaceReader {
    constructor(input, ctx) {
        this._reader = streamUtil.toReader(input);
        this._ctx = ctx;
    }

    read() {
        return this._reader.read()
        .then(res => {
            if (res.done) {
                return res;
            }
            if (typeof res.value === 'string') {
                res.value = res.value.replace(/Test/g, this._ctx.htmlTitle);
            }
            return res;
        });
    }

    cancel(reason) {
        this._reader.cancel(reason);
    }
}

function getCompiledTemplate() {
    if (compiledTemplate) {
        return Promise.resolve(compiledTemplate);
    } else {
        return getTemplate()
            .then(tpl => {
                compiledTemplate = new HTMLTransformReader(tpl, pageTemplateTransforms).drainSync();
                return compiledTemplate;
            });
    }
}

function assemblePage(req, tpl) {
    var title = req.url.match(/\/w\/?iki\/([^?]+)$/)[1];
    const ctx = {
        req: req,
        title: title,
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
    // Finally, wrap into a ReadableStream.
    return streamUtil.toStream(reader);
}

swt.router.get(/https?:\/\/[^\/]+\/w\/?iki\/[^?]+$/,
        (request, options) => {
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
swt.router.get("/w/load.php",
         (request, options) => {
             return swt.cacheFirst(rewriteRequestHost(request), options);
         });

// Boilerplate to ensure our service worker takes control of the page as soon
// as possible.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
