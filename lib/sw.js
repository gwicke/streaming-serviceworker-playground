'use strict';

const tplURL = '/wiki/Test';
const swt = require('sw-toolbox');

swt.precache([tplURL]);
// swt.options.debug = true;
swt.router.default = function(request, options) {
    if (request instanceof Request) {
        return swt.networkFirst(request, options);
    } else {
        return swt.networkFirst(new Request(request), options);
    }
};
swt.options.cache.name = 'default';
swt.options.cache.maxEntries = 5000;

function fetchBody(req, title) {
	const protoHost = req.url.match(/^(https?:\/\/[^\/]+)\//)[1];
    return swt.networkFirst(new Request(protoHost + '/api/rest_v1/page/html/'
                + encodeURIComponent(decodeURIComponent(title))), {
                    cache: {
                        name: 'api_html',
                        maxEntries: 100,
                        maxAgeSeconds: 186400
                    }
    })
    .then(res => {
        if (res.status === 200) {
            return res.text();
        } else {
            return `<body><em style="color: red">Error fetching body for ${title}:
                ${res.status}<em></body>`;
        }
    },
    err => `<body><em style="color: red">Error fetching body for ${title}:
            ${err}</em></body>`);
}

function getTemplate() {
    return swt.cacheFirst(new Request(tplURL)).then(res => res.text());
}

function cheapBodyInnerHTML(html) {
    var match = /<body[^>]*>([\s\S]*)<\/body>/.exec(html);
    if (!match) {
        throw new Error('No HTML body found!');
    } else {
        return match[1];
    }
}

function replaceContent(tpl, content) {
    var bodyMatcher = /(<div id="mw-content-text"[^>]*>)[\s\S]*(<div class="printfooter")/im;
    return tpl.replace(bodyMatcher, (all, start, end) => start + content + end);
}

const escapes = {
    '<': '&lt;',
    '"': '&quot;',
    "'": '&#39;'
};

function injectBody(tpl, body, req, title) {
    // Hack hack hack..
    // In a real implementation, this will
    // - identify page components in a template,
    // - evaluate and each component, and
    // - stream expanded template parts / components as soon as they are
    //   available.
    tpl = tpl.replace(/Test/g, title.split('/').map(decodeURIComponent).join('/')
                                 .replace(/[<"']/g, s => escapes[s])
                                 .replace(/_/g, ' '));
    // Append parsoid and cite css modules
    tpl = tpl.replace(/modules=([^&]+)&/, 'modules=$1%7Cmediawiki.skinning.content.parsoid%7Cext.cite.style&');
    // tpl = tpl.replace(/\/wiki\//g, '/w/iki/');
    return replaceContent(tpl, cheapBodyInnerHTML(body));
}

function assemblePage(req) {
    var title = req.url.match(/\/w\/?iki\/([^?]+)$/)[1];
    return Promise.all([getTemplate(), fetchBody(req, title)])
        .then(results => injectBody(results[0], results[1], req, title));
}

swt.router.get(/https?:\/\/[^\/]+\/w\/?iki\/[^?]+$/,
        (request, options) => assemblePage(request)
            .then(body => new Response(body, {
                headers: {
                    'content-type': 'text/html;charset=utf-8'
                }
            })));
